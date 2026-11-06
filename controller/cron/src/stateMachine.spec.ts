import StateMachine from './StateMachine';

const apiURL = process.env?.API_URL || 'http://localhost:3000';

const stateMachine = new StateMachine(apiURL);

const main = async () => {
  await stateMachine.init();
  // Start the event loop
  while (stateMachine.pairingsLoaded() === false) {
    console.log('+')
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  stateMachine.start()

  // Periodically log the state of all pairings
  const startTime = Date.now()

  setInterval(() => {
    const pairings = stateMachine.getAllPairingStates()
    // pairings.forEach(pairing => {
    //   console.log(`${Date.now() - startTime}) Pairing: ${pairing.sensorId}-${pairing.valveId}, state: ${pairing.state} [next transition: ${pairing.nextTransitionTime}]`);
    // });

  }, 1000)
}

main()