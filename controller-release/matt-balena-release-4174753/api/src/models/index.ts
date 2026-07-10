import { Sequelize } from 'sequelize'
import Group from './group'
import Pairing from './pairing'
import Reading from './reading'
import Rule from './rule'
import Sensor from './sensor'
import User from './user'
import Valve from './valve'
import Zone from './zone'
import System from './system'
import Log from './log'

// intitalize the models
const syncModels = async (): Promise<void> => {
  await Group.sync()
  await Pairing.sync()
  await Reading.sync()
  await Rule.sync()
  await Sensor.sync()
  await User.sync()
  await Valve.sync()
  await Zone.sync()
  await System.sync()
  await Log.sync()
  return
}

const checkModels = (sequelize: Sequelize) => {
  console.log(Group === sequelize.models.Group)
  console.log(Pairing === sequelize.models.Pairing)
  console.log(Reading === sequelize.models.Reading)
  console.log(Rule === sequelize.models.Rule)
  console.log(Sensor === sequelize.models.Sensor)
  console.log(User === sequelize.models.User)
  console.log(Valve === sequelize.models.Valve)
  console.log(Zone === sequelize.models.Zone)
  console.log(System === sequelize.models.System)
  console.log(Log === sequelize.models.Log)
}

export {
  checkModels,
  syncModels,
  Group,
  Pairing,
  Reading,
  Rule,
  Sensor,
  User,
  Valve,
  Zone,
  System,
  Log,
}