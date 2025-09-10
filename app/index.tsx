import { initializeApp } from 'firebase/app';
import { getDatabase, onValue, ref, set } from 'firebase/database';
import { throttle } from 'lodash';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';

// Firebase configuration
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

interface TelemetryData {
  current: number;
  power: number;
  voltage: number;
  energy: number;
  relayState: boolean;
  deviceConnected: boolean;
  timestamp: number;
  heartbeat: number;
  detectedWattage: number;
  expectedCurrent: number;
  currentThreshold: number;
  scheduleActive: boolean;
  overcurrentTripped: boolean;
  scheduleStarted: boolean;
  lastCommandId: string;
  lastCommandTime: number;
}

interface AlertData {
  type: string;
  message: string;
  timestamp: number;
}

interface PendingCommand {
  id: string;
  type: string;
  timestamp: number;
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

interface CommandAck {
  commandId: string;
  type: string;
  result: string;
  processed: boolean;
  timestamp: number;
  deviceTime: number;
}

// Data validation utilities
const validateTelemetryData = (data: any): TelemetryData | null => {
  try {
    if (!data || typeof data !== 'object') {
      console.warn('Invalid telemetry data: not an object');
      return null;
    }

    const parseNumeric = (value: any, fieldName: string, defaultValue: number = 0): number => {
      if (value === null || value === undefined) {
        return defaultValue;
      }
      const parsed = Number(value);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    const parseBoolean = (value: any, fieldName: string, defaultValue: boolean = false): boolean => {
      if (value === null || value === undefined) {
        return defaultValue;
      }
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toLowerCase() === 'true';
      if (typeof value === 'number') return value !== 0;
      return defaultValue;
    };

    const parseTimestamp = (value: any): number => {
      const parsed = parseNumeric(value, 'timestamp', Date.now() / 1000);
      const now = Date.now() / 1000;
      if (parsed < now - 3600 || parsed > now + 3600) {
        return now;
      }
      return parsed;
    };

    const validatedData: TelemetryData = {
      current: Math.max(0, parseNumeric(data.current, 'current')),
      power: Math.max(0, parseNumeric(data.power, 'power')),
      voltage: parseNumeric(data.voltage, 'voltage', 230),
      energy: Math.max(0, parseNumeric(data.energy, 'energy')),
      relayState: parseBoolean(data.relayState, 'relayState'),
      deviceConnected: parseBoolean(data.deviceConnected, 'deviceConnected'),
      timestamp: parseTimestamp(data.timestamp),
      heartbeat: parseTimestamp(data.heartbeat),
      detectedWattage: Math.max(0, parseNumeric(data.detectedWattage, 'detectedWattage')),
      expectedCurrent: Math.max(0, parseNumeric(data.expectedCurrent, 'expectedCurrent')),
      currentThreshold: Math.max(0, parseNumeric(data.currentThreshold, 'currentThreshold', 10)),
      scheduleActive: parseBoolean(data.scheduleActive, 'scheduleActive'),
      scheduleStarted: parseBoolean(data.scheduleStarted, 'scheduleStarted'),
      overcurrentTripped: parseBoolean(data.overcurrentTripped, 'overcurrentTripped'),
      lastCommandId: String(data.lastCommandId || ''),
      lastCommandTime: parseNumeric(data.lastCommandTime, 'lastCommandTime', 0)
    };

    if (validatedData.voltage < 100 || validatedData.voltage > 300) {
      console.warn(`Voltage out of expected range: ${validatedData.voltage}V`);
    }

    if (validatedData.current > 50) {
      console.warn(`Current seems very high: ${validatedData.current}A`);
    }

    return validatedData;
  } catch (error) {
    console.error('Error validating telemetry data:', error);
    return null;
  }
};

const validateAlertData = (data: any): AlertData[] => {
  if (!data || typeof data !== 'object') {
    return [];
  }

  try {
    const alertArray = Object.values(data).filter((alert: any) => {
      return alert &&
        typeof alert === 'object' &&
        alert.type &&
        alert.message &&
        alert.timestamp;
    }).map((alert: any): AlertData => ({
      type: String(alert.type),
      message: String(alert.message),
      timestamp: typeof alert.timestamp === 'string' ? parseInt(alert.timestamp) : Number(alert.timestamp)
    }));

    return alertArray.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
  } catch (error) {
    console.error('Error validating alert data:', error);
    return [];
  }
};

const SmartSocketApp: React.FC = () => {
  // State variables
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [alerts, setAlerts] = useState<AlertData[]>([]);

  // Control states
  const [manualRelay, setManualRelay] = useState(false);

  // Schedule states
  const [scheduleStart, setScheduleStart] = useState('');
  const [scheduleEnd, setScheduleEnd] = useState('');

  // Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [lastDataReceived, setLastDataReceived] = useState<number>(0);
  const [connectionRetryCount, setConnectionRetryCount] = useState(0);

  // Command acknowledgment state
  const [pendingCommands, setPendingCommands] = useState<Map<string, PendingCommand>>(new Map());

  const latestTelemetry = useRef<TelemetryData | null>(null);

  const throttledUpdate = useMemo(
    () => throttle(() => {
      if (latestTelemetry.current) {
        setTelemetry(latestTelemetry.current);
        setManualRelay(latestTelemetry.current.relayState);
      }
    }, 500, { leading: true, trailing: true }),
    []
  );

  const updateUI = useCallback(() => {
    throttledUpdate();
  }, [throttledUpdate]);

  // Utility function to generate unique command IDs
  const generateCommandId = (): string => {
    return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  };

  // Enhanced command sending with acknowledgment
  const sendCommandWithAck = async (commandData: any, commandType: string): Promise<CommandAck> => {
    return new Promise(async (resolve, reject) => {
      let commandId = '';
      try {
        commandId = generateCommandId();
        const pendingCommand: PendingCommand = {
          id: commandId,
          type: commandType,
          timestamp: Date.now(),
          resolve,
          reject
        };
        setPendingCommands(prev => new Map(prev).set(commandId, pendingCommand));
        const finalCommandData = {
          ...commandData,
          commandId: commandId,
          timestamp: Math.floor(Date.now() / 1000)
        };
        await set(ref(database, 'smartSocket/controls'), finalCommandData);
        setTimeout(() => {
          setPendingCommands(prev => {
            const newMap = new Map(prev);
            const cmd = newMap.get(commandId);
            if (cmd) {
              newMap.delete(commandId);
              cmd.reject(new Error(`Command ${commandType} timed out`));
            }
            return newMap;
          });
        }, 10000);
      } catch (error) {
        setPendingCommands(prev => {
          const newMap = new Map(prev);
          newMap.delete(commandId);
          return newMap;
        });
        reject(error);
      }
    });
  };

  // Enhanced error handling for Firebase operations
  const handleFirebaseError = (error: any, operation: string) => {
    console.error(`Firebase ${operation} error:`, error);
    let userMessage = 'Connection error occurred';
    if (error?.code) {
      switch (error.code) {
        case 'PERMISSION_DENIED':
          userMessage = 'Permission denied. Check Firebase rules.';
          break;
        case 'NETWORK_ERROR':
          userMessage = 'Network error. Check internet connection.';
          break;
        case 'UNAVAILABLE':
          userMessage = 'Service temporarily unavailable.';
          break;
        default:
          userMessage = `Error: ${error.message || 'Unknown error'}`;
      }
    }
    Alert.alert('Connection Error', userMessage);
    setIsConnected(false);
  };

  // Connection monitoring
  useEffect(() => {
    const connectionTimer = setInterval(() => {
      const now = Date.now();
      if (lastDataReceived > 0 && now - lastDataReceived > 15000) {
        console.warn('No data received for 15 seconds');
        setIsConnected(false);
      }
    }, 5000);
    return () => clearInterval(connectionTimer);
  }, [lastDataReceived]);

  // Firebase listeners setup
  useEffect(() => {
    let telemetryUnsubscribe: (() => void) | null = null;
    let alertsUnsubscribe: (() => void) | null = null;
    let ackUnsubscribe: (() => void) | null = null;

    const setupFirebaseListeners = () => {
      try {
        const telemetryRef = ref(database, 'smartSocket/telemetry');
        telemetryUnsubscribe = onValue(telemetryRef, (snapshot) => {
          try {
            const data = snapshot.val();
            if (data) {
              const validatedData = validateTelemetryData(data);
              if (validatedData) {
                setIsConnected(true);
                setLastDataReceived(Date.now());
                setConnectionRetryCount(0);
                latestTelemetry.current = validatedData;
                updateUI();
              } else {
                console.warn('Received invalid telemetry data');
              }
            } else {
              console.warn('Received null telemetry data');
            }
          } catch (error) {
            console.error('Error processing telemetry data:', error);
          }
        }, (error) => {
          handleFirebaseError(error, 'telemetry subscription');
          setConnectionRetryCount(prev => prev + 1);
          if (connectionRetryCount < 5) {
            setTimeout(setupFirebaseListeners, Math.pow(2, connectionRetryCount) * 1000);
          }
        });

        const alertsRef = ref(database, 'smartSocket/alerts');
        alertsUnsubscribe = onValue(alertsRef, (snapshot) => {
          try {
            const data = snapshot.val();
            const validatedAlerts = validateAlertData(data);
            setAlerts(validatedAlerts);
          } catch (error) {
            console.error('Error processing alerts data:', error);
          }
        }, (error) => {
          console.error('Alerts subscription error:', error);
        });

        const ackRef = ref(database, 'smartSocket/commandAck');
        ackUnsubscribe = onValue(ackRef, (snapshot) => {
          const data = snapshot.val();
          if (data && typeof data === 'object') {
            Object.values(data).forEach((ack: any) => {
              if (ack && ack.commandId) {
                setPendingCommands(prev => {
                  const newMap = new Map(prev);
                  const pendingCmd = newMap.get(ack.commandId);
                  if (pendingCmd) {
                    newMap.delete(ack.commandId);
                    pendingCmd.resolve(ack);
                    setTimeout(() => {
                      set(ref(database, `smartSocket/commandAck/${ack.commandId}`), null);
                    }, 5000);
                  }
                  return newMap;
                });
              }
            });
          }
        });
      } catch (error) {
        handleFirebaseError(error, 'listener setup');
      }
    };

    setupFirebaseListeners();
    return () => {
      telemetryUnsubscribe?.();
      alertsUnsubscribe?.();
      ackUnsubscribe?.();
    };
  }, [connectionRetryCount, updateUI]);

  // Clean up old pending commands
  useEffect(() => {
    const cleanup = setInterval(() => {
      setPendingCommands(prev => {
        const now = Date.now();
        const newMap = new Map(prev);
        prev.forEach((cmd, id) => {
          if (now - cmd.timestamp > 15000) {
            newMap.delete(id);
            cmd.reject(new Error('Command expired'));
          }
        });
        return newMap;
      });
    }, 5000);
    return () => clearInterval(cleanup);
  }, []);

  // Fixed handleManualControl function
  const handleManualControl = async (value: boolean) => {
    if (!isConnected) {
      Alert.alert('Connection Error', 'Not connected to device. Please check connection.');
      return;
    }
    try {
      const result = await sendCommandWithAck(
        { relayState: value },
        'RELAY_CONTROL'
      );
      if (result.processed) {
        setManualRelay(value);
        Alert.alert('Success', `Socket turned ${value ? 'ON' : 'OFF'} successfully`);
      } else {
        switch (result.result) {
          case 'BLOCKED_PROTECTION_ACTIVE':
            Alert.alert('Operation Blocked', 'Cannot turn on socket - protection is active. Please reset protection first.');
            break;
          case 'NO_CHANGE_REQUIRED':
            Alert.alert('No Change', 'Socket is already in the requested state.');
            break;
          default:
            Alert.alert('Command Not Processed', result.result || 'Unknown reason');
        }
        if (result.result !== 'NO_CHANGE_REQUIRED') {
          setManualRelay(!value);
        }
      }
    } catch (error: any) {
      console.error('Control error:', error);
      if (error.message?.includes('timed out')) {
        Alert.alert('Timeout', 'Command timed out. Device may not be responding.');
      } else {
        Alert.alert('Error', `Failed to control socket: ${error.message}`);
      }
      setManualRelay(!value);
    }
  };

  const validateTimeFormat = (timeString: string): boolean => {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    return timeRegex.test(timeString.trim());
  };

  const parseTimeToTimestamp = (timeString: string): number => {
    const cleanTime = timeString.trim();
    const [hours, minutes] = cleanTime.split(':').map(Number);
    const now = new Date();
    const targetTime = new Date(now);
    targetTime.setHours(hours, minutes, 0, 0);
    if (targetTime.getTime() <= now.getTime()) {
      targetTime.setDate(targetTime.getDate() + 1);
    }
    return targetTime.getTime();
  };

  const handleScheduleSet = async () => {
    if (!scheduleStart.trim() || !scheduleEnd.trim()) {
      Alert.alert('Invalid Schedule', 'Please set both start and end times');
      return;
    }
    if (!validateTimeFormat(scheduleStart) || !validateTimeFormat(scheduleEnd)) {
      Alert.alert('Invalid Time Format', 'Please use HH:MM format (e.g., 14:30)');
      return;
    }
    try {
      const startTime = parseTimeToTimestamp(scheduleStart);
      let endTime = parseTimeToTimestamp(scheduleEnd);
      if (endTime <= startTime) {
        endTime += (24 * 60 * 60 * 1000);
      }
      if ((endTime - startTime) / (1000 * 60 * 60) > 24) {
        Alert.alert('Invalid Schedule', 'Schedule duration cannot exceed 24 hours');
        return;
      }
      await set(ref(database, 'smartSocket/schedule'), {
        active: true,
        startTime: Math.floor(startTime / 1000),
        endTime: Math.floor(endTime / 1000)
      });
      Alert.alert('Success', `Schedule set from ${scheduleStart} to ${scheduleEnd}`);
      setScheduleStart('');
      setScheduleEnd('');
    } catch (error) {
      handleFirebaseError(error, 'schedule set');
    }
  };

  const handleQuickSchedule = async (minutes: number) => {
    if (minutes <= 0 || minutes > 1440) {
      Alert.alert('Invalid Duration', 'Duration must be between 1 and 1440 minutes');
      return;
    }
    try {
      const now = new Date();
      const startTime = Math.floor(now.getTime() / 1000);
      const endTime = startTime + (minutes * 60);
      await set(ref(database, 'smartSocket/schedule'), {
        active: true,
        startTime: startTime,
        endTime: endTime
      });
      const endTimeFormatted = new Date(endTime * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
      Alert.alert('Success', `Socket scheduled for ${minutes} minutes (until ${endTimeFormatted})`);
    } catch (error) {
      handleFirebaseError(error, 'quick schedule');
    }
  };

  const handleCancelSchedule = async () => {
    try {
      await set(ref(database, 'smartSocket/schedule/active'), false);
      Alert.alert('Success', 'Schedule cancelled');
    } catch (error) {
      handleFirebaseError(error, 'schedule cancel');
    }
  };

  const handleResetTrip = async () => {
    try {
      const result = await sendCommandWithAck({ resetTrip: true }, 'RESET_PROTECTION');
      if (result.processed) {
        Alert.alert('Success', 'Overcurrent protection reset successfully');
      } else {
        switch (result.result) {
          case 'BLOCKED_UNSAFE_CONDITIONS':
            Alert.alert('Reset Blocked', 'Cannot reset - unsafe conditions still present.');
            break;
          case 'NO_PROTECTION_ACTIVE':
            Alert.alert('No Action Needed', 'No protection is currently active.');
            break;
          default:
            Alert.alert('Reset Failed', result.result || 'Unknown reason');
        }
      }
    } catch (error: any) {
      if (error.message?.includes('timed out')) {
        Alert.alert('Timeout', 'Reset command timed out. Device may not be responding.');
      } else {
        Alert.alert('Error', `Failed to reset protection: ${error.message}`);
      }
    }
  };

  const getStatusColor = (): string => {
    if (!isConnected) return '#8E8E93'; // Medium Gray for offline
    if (telemetry?.overcurrentTripped) return '#6E6E73'; // Dark Gray for tripped
    if (telemetry?.relayState) return '#000000'; // Black for ON
    return '#BDBDBD'; // Light Gray for OFF
  };

  const ConnectionStatus = () => (
    <View style={styles.connectionStatus}>
      <Text style={styles.connectionText}>
        {isConnected ? 'Connected' : connectionRetryCount > 0 ? `Reconnecting... (${connectionRetryCount})` : 'Connecting...'}
      </Text>
      {lastDataReceived > 0 && (
        <Text style={styles.lastUpdateText}>
          Last update: {Math.floor((Date.now() - lastDataReceived) / 1000)}s ago
        </Text>
      )}
    </View>
  );

  const CommandStatus = () => {
    const pendingCount = pendingCommands.size;
    if (pendingCount === 0) return null;
    return (
      <View style={styles.commandStatus}>
        <Text style={styles.commandStatusText}>
          {pendingCount} command{pendingCount > 1 ? 's' : ''} pending...
        </Text>
      </View>
    );
  };

  const costPerHour = telemetry ? (telemetry.power / 1000) * 209.50 : 0;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Shop Control</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <CommandStatus />
            <View style={[styles.statusIndicator, { backgroundColor: getStatusColor() }]}>
              <Text style={styles.statusText}>
                {!isConnected ? 'Offline' :
                  telemetry?.overcurrentTripped ? 'Tripped' :
                    telemetry?.relayState ? 'ON' : 'OFF'}
              </Text>
            </View>
          </View>
        </View>

        <ConnectionStatus />

        <View style={styles.controlCard}>
          <TouchableOpacity
            style={[styles.switchButton, manualRelay ? styles.switchButtonOn : styles.switchButtonOff]}
            onPress={() => handleManualControl(!manualRelay)}
            disabled={!isConnected || pendingCommands.size > 0}
          >
            <Text style={[styles.switchButtonText, manualRelay ? styles.switchButtonTextOn : styles.switchButtonTextOff]}>
              {manualRelay ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>

          <Text style={styles.switchHint}>TAP TO SWITCH</Text>
        </View>

        {telemetry && (
          <View style={styles.costCard}>
            <Text style={styles.costLabel}>Estimated Cost Per Hour</Text>
            <Text style={styles.costValue}>{costPerHour.toFixed(2)} ₦</Text>
          </View>
        )}

        {telemetry?.overcurrentTripped && (
          <TouchableOpacity
            style={[styles.resetButton, pendingCommands.size > 0 && styles.disabledButton]}
            onPress={handleResetTrip}
            disabled={pendingCommands.size > 0}
          >
            <Text style={styles.resetButtonText}>Reset Overcurrent Protection</Text>
          </TouchableOpacity>
        )}

        {telemetry && (
          <View style={styles.statusRow}>
            {/* Power Card */}
            <View style={styles.individualStatusCard}>
              <Text style={styles.statusLabel}>Power</Text>
              <Text style={styles.statusValue}>{telemetry.power.toFixed(1)}W</Text>
            </View>

            {/* Current Card */}
            <View style={styles.individualStatusCard}>
              <Text style={styles.statusLabel}>Current</Text>
              <Text style={styles.statusValue}>{telemetry.current.toFixed(2)}A</Text>
            </View>

            {/* Voltage Card - Full Width */}
            <View style={styles.fullWidthStatusCard}>
              <Text style={styles.statusLabel}>Voltage</Text>
              <Text style={styles.statusValue}>{telemetry.voltage.toFixed(0)}V</Text>
            </View>
          </View>
        )}

        <View style={styles.controlCard}>
          <Text style={styles.cardTitle}>Quick Schedule</Text>
          <View style={styles.quickScheduleButtons}>
            <TouchableOpacity
              style={styles.quickButton}
              onPress={() => handleQuickSchedule(15)}
            >
              <Text style={styles.quickButtonText}>15 min</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickButton}
              onPress={() => handleQuickSchedule(30)}
            >
              <Text style={styles.quickButtonText}>30 min</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickButton}
              onPress={() => handleQuickSchedule(60)}
            >
              <Text style={styles.quickButtonText}>1 hour</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quickButton}
              onPress={() => handleQuickSchedule(120)}
            >
              <Text style={styles.quickButtonText}>2 hours</Text>
            </TouchableOpacity>
          </View>
          {telemetry?.scheduleActive && (
            <TouchableOpacity style={styles.cancelButton} onPress={handleCancelSchedule}>
              <Text style={styles.cancelButtonText}>Cancel Active Schedule</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.controlCard}>
          <Text style={styles.cardTitle}>Custom Schedule</Text>
          <View style={styles.scheduleInputs}>
            <View style={styles.timeInputContainer}>
              <Text style={styles.inputLabel}>Start Time</Text>
              <TextInput
                style={styles.timeInput}
                value={scheduleStart}
                onChangeText={setScheduleStart}
                placeholder="HH:MM"
                placeholderTextColor="#BDBDBD"
              />
            </View>
            <View style={styles.timeInputContainer}>
              <Text style={styles.inputLabel}>End Time</Text>
              <TextInput
                style={styles.timeInput}
                value={scheduleEnd}
                onChangeText={setScheduleEnd}
                placeholder="HH:MM"
                placeholderTextColor="#BDBDBD"
              />
            </View>
          </View>
          <TouchableOpacity style={styles.setButton} onPress={handleScheduleSet}>
            <Text style={styles.setButtonText}>Set Schedule</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView >
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F7',
    height: "100%"
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#000000',
  },
  statusIndicator: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
  },
  statusText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 12,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    marginTop: 10,
  },
  individualStatusCard: {
    backgroundColor: '#FFFFFF',
    padding: 20,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    width: '48%',
    marginBottom: 15,
    alignItems: 'center',
  },
  fullWidthStatusCard: {
    backgroundColor: '#FFFFFF',
    padding: 20,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    width: '100%',
    marginBottom: 15,
    alignItems: 'center',
  },
  statusLabel: {
    color: '#6E6E73',
    fontSize: 14,
    marginBottom: 5,
  },
  statusValue: {
    color: '#000000',
    fontSize: 20,
    fontWeight: 'bold',
  },
  costCard: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 20,
    marginTop: 15,
    paddingVertical: 20,
    paddingHorizontal: 15,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#E0E0E0',
    alignItems: 'center',
  },
  costLabel: {
    color: '#6E6E73',
    fontSize: 16,
    marginBottom: 8,
  },
  costValue: {
    color: '#000000',
    fontSize: 32,
    fontWeight: 'bold',
  },
  connectionStatus: {
    alignItems: 'flex-end',
    paddingHorizontal: 20,
    marginTop: 5,
  },
  connectionText: {
    color: '#6E6E73',
    fontSize: 10,
  },
  lastUpdateText: {
    color: '#8E8E93',
    fontSize: 8,
  },
  cardTitle: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 15,
    textAlign: 'center',
  },
  controlCard: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 20,
    marginTop: 10,
    padding: 20,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  resetButton: {
    backgroundColor: '#D9534F',
    paddingVertical: 12,
    borderRadius: 8,
    marginHorizontal: 20,
    marginTop: 10,
  },
  resetButtonText: {
    color: '#FFFFFF',
    textAlign: 'center',
    fontWeight: '600',
  },
  quickScheduleButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  quickButton: {
    backgroundColor: '#E5E5E5',
    paddingVertical: 10,
    paddingHorizontal: 15,
    borderRadius: 8,
    width: '48%',
    marginBottom: 10,
  },
  quickButtonText: {
    color: '#000000',
    textAlign: 'center',
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: '#BDBDBD',
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 10,
  },
  cancelButtonText: {
    color: '#000000',
    textAlign: 'center',
    fontWeight: '600',
  },
  scheduleInputs: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  timeInputContainer: {
    width: '48%',
  },
  inputLabel: {
    color: '#6E6E73',
    fontSize: 14,
    marginBottom: 8,
  },
  timeInput: {
    backgroundColor: '#F5F5F7',
    color: '#000000',
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: 8,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#D2D2D7',
  },
  setButton: {
    backgroundColor: '#000000',
    paddingVertical: 12,
    borderRadius: 8,
  },
  setButtonText: {
    color: '#FFFFFF',
    textAlign: 'center',
    fontWeight: '600',
  },
  commandStatus: {
    backgroundColor: '#BDBDBD',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 12,
    marginRight: 10,
  },
  commandStatusText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.5
  },
  switchHint: {
    fontSize: 14,
    color: '#828282',
    marginTop: 8,
    textAlign: 'center',
    letterSpacing: 1,
  },
  switchButton: {
    width: 180,
    height: 180,
    borderRadius: 90,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginVertical: 10,
    borderWidth: 5,
  },
  switchButtonOn: {
    borderColor: '#000000',
    backgroundColor: '#f0f0f0',
  },
  switchButtonOff: {
    borderColor: '#BDBDBD',
    backgroundColor: 'transparent',
  },
  switchButtonText: {
    fontSize: 48,
    fontWeight: 'bold',
  },
  switchButtonTextOn: {
    color: '#000000',
  },
  switchButtonTextOff: {
    color: '#BDBDBD',
  },
});

export default SmartSocketApp;