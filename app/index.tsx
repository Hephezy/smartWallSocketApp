import { initializeApp } from 'firebase/app';
import { getDatabase, onValue, ref, set } from 'firebase/database';
import { throttle } from 'lodash';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';

// Firebase configuration (ensure this is correct)
const firebaseConfig = {
  apiKey: "AIzaSyDAGy-LE_zlDGQzFUX1BN_ukdGJptu4hQg",
  authDomain: "smart-socket-5569e.firebaseapp.com",
  databaseURL: "https://smart-socket-5569e-default-rtdb.firebaseio.com",
  projectId: "smart-socket-5569e",
  storageBucket: "smart-socket-5569e.firebasestorage.app",
  messagingSenderId: "499097667526",
  appId: "1:499097667526:web:9fb92186cc82e99dec54c7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// --- INTERFACES ---
interface TelemetryData {
  current: number;
  power: number;
  voltage: number;
  energy: number;
  relayState: boolean;
  timestamp: number;
}

interface PendingCommand {
  id: string;
  type: string;
  timestamp: number;
  reject: (error: any) => void;
}

// --- DATA VALIDATION ---
const validateTelemetryData = (data: any): TelemetryData | null => {
  try {
    if (!data || typeof data !== 'object') {
      console.warn('Invalid telemetry data: not an object');
      return null;
    }

    const parseNumeric = (value: any, defaultValue: number = 0): number => {
      if (value === null || value === undefined) return defaultValue;
      const parsed = Number(value);
      return isNaN(parsed) ? defaultValue : parsed;
    };

    const parseBoolean = (value: any, defaultValue: boolean = false): boolean => {
      if (value === null || value === undefined) return defaultValue;
      if (typeof value === 'boolean') return value;
      return defaultValue;
    };

    const validatedData: TelemetryData = {
      current: Math.max(0, parseNumeric(data.current)),
      power: Math.max(0, parseNumeric(data.power)),
      voltage: parseNumeric(data.voltage, 230),
      energy: Math.max(0, parseNumeric(data.energy)),
      relayState: parseBoolean(data.relayState),
      timestamp: parseNumeric(data.timestamp, Date.now() / 1000),
    };

    return validatedData;
  } catch (error) {
    console.error('Error validating telemetry data:', error);
    return null;
  }
};

// --- MAIN APP COMPONENT ---
const SmartWallSocketApp: React.FC = () => {
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastDataReceived, setLastDataReceived] = useState<number>(0);
  const [pendingCommands, setPendingCommands] = useState<Map<string, PendingCommand>>(new Map());
  const [manualRelay, setManualRelay] = useState(false);

  const latestTelemetry = useRef<TelemetryData | null>(null);

  // Throttle UI updates for smoother performance
  const throttledUpdate = useMemo(
    () => throttle(() => {
      if (latestTelemetry.current) {
        setTelemetry(latestTelemetry.current);
      }
    }, 500, { leading: true, trailing: true }),
    []
  );

  const updateUI = useCallback(() => {
    throttledUpdate();
  }, [throttledUpdate]);

  // --- COMMAND HANDLING ---
  const generateCommandId = (): string => {
    return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  };

  const sendCommand = async (commandData: any, commandType: string) => {
    return new Promise<void>(async (resolve, reject) => {
      const commandId = generateCommandId();
      try {
        const pendingCommand: PendingCommand = {
          id: commandId,
          type: commandType,
          timestamp: Date.now(),
          reject
        };
        setPendingCommands(prev => new Map(prev).set(commandId, pendingCommand));

        await set(ref(database, 'smartSocket/controls'), {
          ...commandData,
          commandId: commandId,
          timestamp: Math.floor(Date.now() / 1000)
        });

        // Command timeout
        setTimeout(() => {
          setPendingCommands(prev => {
            const newMap = new Map(prev);
            if (newMap.has(commandId)) {
              newMap.delete(commandId);
              reject(new Error(`Command ${commandType} timed out`));
            }
            return newMap;
          });
        }, 10000);

        resolve();

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

  const handleFirebaseError = (error: any, operation: string) => {
    console.error(`Firebase ${operation} error:`, error);
    Alert.alert('Connection Error: An error occurred. Please check your connection.');
    setIsConnected(false);
  };

  // --- EFFECTS ---

  useEffect(() => {
    if (telemetry) {
      setManualRelay(telemetry.relayState);
    }
  }, [telemetry]);

  // Connection monitoring
  useEffect(() => {
    const connectionTimer = setInterval(() => {
      const now = Date.now();
      if (lastDataReceived > 0 && now - lastDataReceived > 15000) {
        console.warn('No data received for 15 seconds. Marking as disconnected.');
        setIsConnected(false);
      }
    }, 5000);
    return () => clearInterval(connectionTimer);
  }, [lastDataReceived]);

  // Firebase telemetry listener
  useEffect(() => {
    const telemetryRef = ref(database, 'smartSocket/telemetry');
    const unsubscribe = onValue(telemetryRef, (snapshot) => {
      try {
        const data = snapshot.val();
        if (data) {
          const validatedData = validateTelemetryData(data);
          if (validatedData) {
            setIsConnected(true);
            setLastDataReceived(Date.now());
            latestTelemetry.current = validatedData;
            updateUI();
          } else {
            console.warn('Received invalid telemetry data');
          }
        }
      } catch (error) {
        console.error('Error processing telemetry data:', error);
      }
    }, (error) => {
      handleFirebaseError(error, 'telemetry subscription');
    });

    return () => unsubscribe();
  }, [updateUI]);

  // --- USER ACTIONS ---
  const handleToggleSwitch = async () => {
    if (!isConnected) {
      alert('Not Connected: Cannot send command. Please check the connection to the device.');
      return;
    }
    if (pendingCommands.size > 0) {
      alert('Please Wait: Another command is already in progress.');
      return;
    }

    const newState = !manualRelay;
    setManualRelay(newState); // Optimistic UI update

    try {
      await sendCommand({ relayState: newState }, 'RELAY_CONTROL');
      // The UI will be corrected by the onValue listener if the command somehow failed silently on the device
    } catch (error: any) {
      console.error('Control error:', error);
      alert(`Error: Failed to toggle socket: ${error.message}`);
      setManualRelay(!newState); // Revert UI on failure
    }
  };

  // --- RENDER ---
  const isRelayOn = manualRelay;
  const statusText = isRelayOn ? 'ON' : 'OFF';

  const combinedButtonStyle = {
    ...styles.switchButton,
    ...(isRelayOn ? styles.switchButtonOn : styles.switchButtonOff)
  };

  const combinedButtonTextStyle = {
    ...styles.switchButtonText,
    ...(isRelayOn ? styles.switchButtonTextOn : styles.switchButtonTextOff)
  };

  return (
    <View style={styles.safeArea}>
      <View style={styles.container}>
        <TouchableOpacity
          style={combinedButtonStyle}
          onPress={handleToggleSwitch}
          disabled={!isConnected || pendingCommands.size > 0}
        >
          <Text style={combinedButtonTextStyle}>
            {statusText}
          </Text>
        </TouchableOpacity>
        <Text style={styles.switchHint}>TAP TO SWITCH</Text>

        <View style={styles.statsContainer}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{telemetry?.power.toFixed(1) ?? '0.0'}</Text>
            <Text style={styles.statUnit}> WATTS</Text>
            <Text style={styles.statLabel}>POWER</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{telemetry?.voltage.toFixed(1) ?? '0.0'}</Text>
            <Text style={styles.statUnit}> VOLT</Text>
            <Text style={styles.statLabel}>VOLTAGE</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{telemetry?.current.toFixed(1) ?? '0.0'}</Text>
            <Text style={styles.statUnit}> AMPS</Text>
            <Text style={styles.statLabel}>CURRENT</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{telemetry?.energy.toFixed(3) ?? '0.0'}</Text>
            <Text style={styles.statUnit}> JOULES</Text>
            <Text style={styles.statLabel}>ENERGY</Text>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    height: '100%',
    display: 'flex',
  },
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    fontFamily: 'sans-serif'
  },
  switchButton: {
    width: 200,
    height: 200,
    borderRadius: '50%',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    boxShadow: '0px 5px 15px rgba(0, 0, 0, 0.1)',
    cursor: 'pointer',
    display: 'flex',
    backgroundColor: 'transparent',
  },
  switchButtonOn: {
    borderWidth: 1,
    borderColor: '#0052FF',
    borderStyle: 'solid',
  },
  switchButtonOff: {
    borderWidth: 1,
    borderColor: '#BDBDBD',
    borderStyle: 'solid',
  },
  switchButtonText: {
    fontSize: 64,
    fontWeight: 'bold',
  },
  switchButtonTextOn: {
    color: '#0052FF',
  },
  switchButtonTextOff: {
    color: '#BDBDBD',
  },
  switchHint: {
    fontSize: 16,
    color: '#828282',
    letterSpacing: 1,
    marginBottom: 40,
  },
  statsContainer: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    width: '100%',
    maxWidth: 500
  },
  statCard: {
    backgroundColor: '#FFFFFF',
    width: '48%',
    height: 150,
    padding: 20,
    borderRadius: 20,
    marginBottom: 15,
    boxShadow: '0px 2px 10px rgba(0, 0, 0, 0.05)',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderStyle: 'solid',
    boxSizing: 'border-box'
  },
  statValue: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#0052FF',
    margin: 0,
  },
  statUnit: {
    fontSize: 16,
    fontWeight: 'normal',
    color: '#0052FF',
    margin: 0,
    marginTop: 8
  },
  statLabel: {
    fontSize: 14,
    color: '#828282',
    marginTop: 24,
    margin: 0,
  },
});

export default SmartWallSocketApp;

