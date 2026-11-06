// import { Group, Pairing, Rule, Sensor, Reading, User, Valve, Zone } from "./lib/types";

// // Helper function to generate deterministic random numbers
// const seededRandom = (seed: number) => {
//     const x = Math.sin(seed) * 10000;
//     return x - Math.floor(x);
// };

// // Sensors
// export const getFakeSensors = (): Sensor[] => {
//     const sensors: Sensor[] = [
//         {
//             id: "temp_sensor_1",
//             name: "Temperature Sensor 1",
//             type: "temperature",
//             description: "Temperature Sensor 1 Description",
//             address: "192.168.1.101",
//         },
//         {
//             id: "humidity_sensor_1",
//             name: "Humidity Sensor 1",
//             type: "humidity",
//             description: "Humidity Sensor 1 Description",
//             address: "192.168.1.102",
//         },
//         {
//             id: "temp_sensor_2",
//             name: "Temperature Sensor 2",
//             type: "temperature",
//             description: "Temperature Sensor 2 Description",
//             address: "192.168.1.103",
//         },
//         {
//             id: "humidity_sensor_2",
//             name: "Humidity Sensor 2",
//             type: "humidity",
//             description: "Humidity Sensor 2 Description",
//             address: "192.168.1.104",
//         },
//     ];
//     return sensors;
// };

// // Sensor Readings
// export const getFakeSensorReadings = (): Reading[] => {
//     const rightNow = Date.now();
//     const sensors_to_generate_readings_for = [
//         { id: 'temp_sensor_1', range: [21, 31] },
//         { id: 'temp_sensor_2', range: [18, 28] },
//         { id: 'humidity_sensor_1', range: [45, 65] },
//         { id: 'humidity_sensor_2', range: [40, 60] },
//     ];

//     const readings: Reading[] = [];
//     sensors_to_generate_readings_for.forEach((sensor) => {
//         readings.push(...Array.from({ length: 15 }, (_, i) => {
//             const timestamp = Math.floor((rightNow - (i * 3000)) / 1000);
//             const [min, max] = sensor.range;
//             const lastDigitOfName = sensor.id.slice(-1);
//             const randomValue = Number(
//                 (seededRandom(timestamp * Number(lastDigitOfName)) * (max - min) + min).toFixed(1)
//             );

//             return {
//                 id: sensor.id,
//                 sensor_id: sensor.id,
//                 type: sensor.id.split('_')[0],
//                 value: randomValue,
//                 timestamp: new Date(timestamp * 1000).toISOString(),
//             };

//         }));
//     });
//     return readings;
// };

// // Valves
// export const getFakeValves = (): Valve[] => {
//     return [
//         {
//             id: "valve_1",
//             name: "Valve 1",
//             description: "Valve 1 Description",
//         },
//         {
//             id: "valve_2",
//             name: "Valve 2",
//             description: "Valve 2 Description",
//         },
//         {
//             id: "valve_3",
//             name: "Valve 3",
//             description: "Valve 3 Description",
//         },
//     ];
// };

// // Users
// export const getFakeUsers = (): User[] => {
//     return [
//         {
//             id: "user_1",
//             name: "admin",
//             email: "admin@example.com",
//             firstname: "Admin",
//             lastname: "User",
//             isActive: true,
//             isAdmin: true,
//             created: new Date("2024-01-01"),
//             modified: new Date("2024-01-01"),
//         },
//         {
//             id: "user_2",
//             name: "operator",
//             email: "operator@example.com",
//             firstname: "Regular",
//             lastname: "User",
//             isActive: true,
//             isAdmin: false,
//             created: new Date("2024-01-02"),
//             modified: new Date("2024-01-02"),
//         },
//         {
//             id: "0194717e-ece2-7c19-b319-4094bbfe8476",
//             name: "CWD",
//             email: "cwd@ursascience.com",
//             firstname: "CWD",
//             lastname: "User",
//             isActive: true,
//             isAdmin: true,
//             created: new Date("2024-01-01"),
//             modified: new Date("2024-01-01"),
//         }
//     ];
// };

// // Groups
// export const getFakeGroups = (): Group[] => {
//     return [
//         {
//             id: "group_1",
//             name: "Greenhouse 1",
//         },
//         {
//             id: "group_2",
//             name: "Greenhouse 2",
//         },
//     ];
// };

// // Zones
// export const getFakeZones = (): Zone[] => {
//     return [
//         {
//             id: "zone_1",
//             name: "Zone A",
//             description: "Zone A Description",
//         },
//         {
//             id: "zone_2",
//             name: "Zone B",
//             description: "Zone B Description",
//         },
//     ];
// };

// // Rules
// export const getFakeRules = (): Rule[] => {
//     return [
//         {
//             id: "rule_1",
//             rule: {
//                 condition: "temperature > 30",
//                 action: "activate_cooling",
//             },
//         },
//         {
//             id: "rule_2",
//             rule: {
//                 condition: "humidity < 40",
//                 action: "activate_humidifier",
//             },
//         },
//     ];
// };


// // Pairs
// export const getFakePairs = (): Pairing[] => {
//     return [
//         {
//             id: "pair_1",
//             sensor_id: "temp_sensor_1",
//             valve_id: "valve_1",
//         },
//         {
//             id: "pair_2",
//             sensor_id: "humidity_sensor_1",
//             valve_id: "valve_2",
//         },
//     ];
// };
