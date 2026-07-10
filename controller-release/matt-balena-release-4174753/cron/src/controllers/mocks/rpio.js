module.exports = {
  init: (options) => {
    console.log(`Mock rpio.init called with options: ${JSON.stringify(options)}`);
  },
  open: (pin, mode, state) => {
    console.log(`Mock rpio.open called for pin ${pin}, mode ${mode}, state ${state}`);
  },
  write: (pin, state) => {
    console.log(`Mock rpio.write called for pin ${pin}, state ${state}`);
  },
  HIGH: 1,
  LOW: 0,
  OUTPUT: 'output',
};