
// Periodic task to check current time every second
export const fakeDataInsertLoop = () => {
  let counter = 0
  let sensorId: string | undefined
  setInterval(() => {
    const now = new Date()
    console.log(`${counter}\t- Current time: ${now.toLocaleTimeString()}`)
    //CWD-- this simulates rules engine run to check if any rules should be triggered and data collected
    counter++
    if (counter === 5) {
      const userResponse = fetch('http://api_svc:8888/v1/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'tom',
          email: 'tom@forwardtechfl.com',
          password: 'password', //TODO: encrypt password
          firstname: 'Tom',
          lastname: 'Forward',
          isAdmin: false,
          isActive: true,
          adminPassword: '_admin_password_'
        }),
      })
      // create a sensor by making a post to localhost:8888/v1/sensors
      const response = fetch('http://api_svc:8888/v1/sensors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Sensor tom',
          type: 'temperature',
          description: 'Temperature sensor',
          address: '192.168.123.456',
          boardSerialId: '1234567890'
        }),
      })
        .then(res => {
          const response2 = fetch('http://api_svc:8888/v1/sensors', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Sensor jerry',
              type: 'temperature',
              description: 'Temperature sensor',
              address: '123.234.345.456',
              boardSerialId: '1234567890'
            }),
          })
            .then(res => {
              const response3 = fetch('http://api_svc:8888/v1/sensors', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  name: 'Sensor Nibbles',
                  type: 'temperature',
                  description: 'A fun description',
                  address: '123.345.456.567',
                  boardSerialId: '9876543210'
                }),

              })
                .then(res => {
                  fetch('http://api_svc:8888/v1/logs', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ level: 'info', message: 'Fake sensor created', source: 'cron', data: { sensorId: '1' } }),
                  })
                })
            })
        })
        .catch(err => {
          console.error('Error creating sensor', err)
          fetch('http://api_svc:8888/v1/logs', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ level: 'error', message: 'Error creating sensor', source: 'cron', data: { error: err } }),
          })
        })
    } else if (counter === 6) {
      // create a valve
      const response = fetch('http://api_svc:8888/v1/valves', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address: '192.168.123.456', relayAddress: '192.168.123.456' }),
      }).then(res => {
        // create another valve
        const response = fetch('http://api_svc:8888/v1/valves', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ address: '1.2.3.4', relayAddress: '1.2.3.4' }),
        }).then(res => {
          res.json().then(data => {
            console.log('created valve', data)
            const valveId = data.id ?? '1'
            fetch('http://api_svc:8888/v1/logs', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ level: 'info', message: 'Fake valve created', source: 'cron', data: { valveId: valveId ?? '1' } }),
            })
          })
        }).catch(err => {
          console.error('Error creating valve', err)
          fetch('http://api_svc:8888/v1/logs', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ level: 'error', message: 'Error creating valve', source: 'cron', data: { error: err } }),
          })
        })
      })
    } else if (counter > 10 && counter % 5 === 0) {
      // create a reading by making a post to localhost:8888/v1/readings
      const response = fetch('http://api_svc:8888/v1/readings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sensorId: counter % 2 === 0 ? '1' : '2',
          rawValue: 180 + (Math.sin(counter / 4) * 45) + ((counter % 7) * 3) + (counter % 2 === 0 ? 12 : -12) + (Math.random() * 8),
          calibratedValue: 38 + (Math.cos(counter / 9) * 14) + (((counter % 11) - 5) * 0.9) + (counter % 2 === 0 ? -3 : 3) + (Math.random() * 2),
          temperature: Math.random() < 0.2 ? null : (22 + (Math.sin((counter / 13) + (Math.PI / 3)) * 6) + (Math.cos(counter / 5) * 2) + (counter % 3 === 0 ? 1.5 : -1) + (Math.random() * 0.8)),
          electricalConductivity: 700 + (Math.cos((counter / 6) + (Math.PI / 2)) * 180) + ((counter % 10) * 16) + (counter % 2 === 0 ? 60 : -60) + (Math.random() * 25)
        }),
      }).then(res => {
        res.json().then(data => {
          console.log('created reading')
          fetch('http://api_svc:8888/v1/logs', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ level: 'info', message: 'Fake reading created', source: 'cron', data: { sensorId: counter % 2 === 0 ? '1' : '2' } }),
          })
        })
      }).catch(err => {
        console.error('Error creating reading', err)
        fetch('http://api_svc:8888/v1/logs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ level: 'error', message: 'Error creating reading', source: 'cron', data: { error: err } }),
        })
      })
    }
  }, 1000)
}
