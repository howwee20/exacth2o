#!/usr/local/opt/python-3.5.1/bin/python3.5
# 2022-01-19 Added GPIO feature for irrigation
# 2021-10-25 Updated to up to 8 fields for thingspeak and updated API address. Also removed curl and used request
# SDI-12 Sensor Data Logger Copyright Dr. John Liu 2017-11-06
# 2017-11-06 Updated telemetry code to upload to thingspeak.com from data.sparkfun.com.
# 2017-06-23 Added exception handling in case the SDI-12 + GPS USB adapter doesn't return any data (no GPS lock).
#            Added serial port and file closing in ctrl + C handler.
# 2017-02-02 Added multiple-sensor support. Just type in multiple sensor addresses when asked for addresses.
#            Changed sdi_12_address into regular string from byte string. I found out that byte strings when iterated over becomes integers.
#            It's easy to cast each single character string into byte string with .encode() when needed as address.
#            Removed specific analog input code and added the adapter address to the address string instead.
# 2016-11-12 Added support for analog inputs
# 2016-07-01 Added .strip() to remove \r from input files typed in windows
# Added Ctrl-C handler
# Added sort of serial port placing FTDI at item 0 if it exists
#Added exception handling (By binod)
#Added column header capability in the csv file (By Binod)

# Credentials
thingspeak_channelID = "359964"
thingspeak_api_key = "GTOEBKK8ZQHI1V1B"

min_VWC_percent={
    'A': 1,
    'B': 25, #turned off for a few days due to overly high VWC, may be an issue with the sensors or irrigation design. Turned off on 2/2, back on 2/5
    'C': 1,
    'D': 1,
    'E': 1,
    'F': 25,
    'G': 1,
    'H': 1,
    'I': 25,
    'J': 1,
    'K': 1,
    'L': 25,
    'M': 25,
    'N': 25,
    'O': 25,
    'P': 25
    }


try:
    import RPi.GPIO as GPIO
except ImportError:
    print("RPi.GPIO not available, using mock GPIO for development")
    import mock_rpi_gpio as GPIO

GPIO.setmode(GPIO.BOARD)

import datetime  # For finding system's real time
import json
import os  # For running command line commands
import platform  # For detecting operating system flavor
import re  # For regular expression support
import serial.tools.list_ports  # For listing available serial ports
import serial  # For serial communication
import signal  # For trapping ctrl-c or SIGINT
import sys  # For exiting program with exit code
import time  # For delaying in seconds
import urllib.parse  # For encoding data to be url safe.
import urllib.request  # send data to online server
import \
    requests  # sends data to cloud. To install this module, in RPI, open a terminal window, then type sudo pip3 install requests


def SIGINT_handler(signal, frame):
    try:
        ser.close()
    except:
        pass
    try:
        data_file.close()
    except:
        pass
    print('Quitting program!')
    sys.exit(0)


signal.signal(signal.SIGINT, SIGINT_handler)


def TER12_VWC_percentage_Custom(RAW):
    #return RAW
    # return 100*(6.771e-10*RAW**3-5.105e-6*RAW**2+1.302e-2*RAW-10.848)
    # return 2e-05*RAW**2-0.0524*RAW+24.89
    # return 2e-05*RAW**2-0.0699*RAW+44.625
    return 4e-05 * RAW ** 2 - 0.1289 * RAW + 100.68


# def TER12_VWC_percentage_Custom(RAW):
# return 3.879e-4*RAW-0.6956

thingspeak_request_url_format = 'https://api.thingspeak.com/update.json?api_key=%s%s'  # This is the upload API to thingspeak.com
thingspeak_max_value_per_chn = 8  # Maximal values to upload as a single data point

unit_id = platform.node()  # Use computer name as unit_id. For a raspberry pi, change its name from raspberrypi to something else to avoid confusion
adapter_sdi_12_address = 'z'
no_data = False  # This is the flag to break out of the inner loops and continue the next data point loop in case no data is received from a sensor such as the GPS.

print('+-' * 40)
print('SDI-12 Sensor and Analog Sensor Python Data Logger with irrigation control and Telemetry V1.5.0')
print(
    'Designed for Dr. Liu\'s family of SDI-12 USB adapters (standard,analog,GPS)\n\tDr. John Liu Saint Cloud MN USA 2022-01-19\n')
print('\nCompatible with Windows, GNU/Linux, Mac OSX, and Raspberry PI')
print('\nThis program requires Python 3.4, Pyserial 3.0, requests and urllib (data upload)')
print('\nData is logged to YYYYMMDD.CVS in the Python code\'s folder')
print('\nVisit https://thingspeak.com/channels/%s to inspect or retrive data' % (thingspeak_channelID))
# print('\nIf multiple people are running this code, they are distinguished by unit_id, although all raspberry pis have the same "raspberrypi" unit_id.')
print(
    '\nFor assistance with customization, telemetry etc., contact Dr. Liu.\n\thttps://liudr.wordpress.com/gadget/sdi-12-usb-adapter/')
print('+-' * 40)

ports = []
VID_FTDI = 0x0403;

a = serial.tools.list_ports.comports()
for w in a:
    ports.append((w.vid, w.device))

ports.sort(key=lambda ports: ports[1])

print('\nDetected the following serial ports:')
i = 0
for w in ports:
    print('%d)\t%s\t(USB VID=%04X)' % (i, w[1], w[0] if (type(w[0]) is int) else 0))
    i = i + 1
total_ports = i  # now i= total ports

user_port_selection = input('\nSelect port from list (0,1,2...). SDI-12 adapter has USB VID=0403:')
if (int(user_port_selection) >= total_ports):
    exit(1)  # port selection out of range

#Binod added this error handling here on 12/10/2023
try:
    ser = serial.Serial(port=(ports[int(user_port_selection)])[1], baudrate=9600, timeout=10)
except serial.SerialException as e:
    print(f"Error opening serial port: {e}")
    sys.exit(1)

time.sleep(5)  # delay for arduino bootloader and the 1 second delay of the adapter.

# total_data_count=int(input('Total number of data points:'))
total_data_count = float('inf')  # total_data_count is set to infinity
delay_between_pts = int(input('Delay between data points (second):'))

print('Time stamps are generated with:\n0) GMT/UTC\n1) Local\n')
time_zone_choice = int(input('Select time zone.'))

sdi_12_address = ''
relay_GPIO = {}  # This is the dictionary of the GPIO controlling the relay for the corresponding sensor' pot, such as {'1':18,'2':19}
user_sdi_12_address = input('Enter all SDI-12 sensor addresses, such as N,O,P,H,G,I,F,E,D,C,B,A,J,K,L,M:')
user_GPIO_pins = input(
    'Enter all RPI GPIO BOARD pins controlling relays in the order of the sensors, such as 3,5,7,8,10,11,12,16,18,22,24,26,32,36,38,40:')
relay_GPIO = dict(zip(user_sdi_12_address.split(','), list(map(lambda x: int(x), user_GPIO_pins.split(',')))))
user_sdi_12_address = user_sdi_12_address.strip()  # Remove any \r from an input file typed in windows

for an_address in sorted(relay_GPIO.keys()):
    print(an_address)
    ser.write(an_address.encode() + b'I!')
    sdi_12_line = ser.readline()
    print(sdi_12_line)
    if ((an_address >= '0') and (an_address <= '9')) or ((an_address >= 'A') and (an_address <= 'Z')) or (
            (an_address >= 'a') and (an_address <= 'z')):
        GPIO.setup(relay_GPIO[an_address], GPIO.OUT)
        GPIO.output(relay_GPIO[an_address], GPIO.HIGH)
        print("Sensor address: %s Sensor info: %s --> Relay GPIO: %2d" % (
        an_address, sdi_12_line.decode('utf-8').strip()[3:], relay_GPIO[an_address]))
        sdi_12_address = sdi_12_address + an_address
    else:
        print('Invalid address:', an_address)
print()
GPIO.setwarnings(False)
try:#added by binod for exception handling
    while True:  # Infinite loop
        if total_data_count != float('inf'):
            data_points = range(total_data_count)
        else:
            data_points = iter(int, 1)
            for j in data_points:
                try:
                    thingspeak_values_str = ''  # This stores &value0=xxx&value1=xxx&value2=xxx&value3=xxx&value4=xxx&value5=xxx and is only reset after all sensors are read.
                    if time_zone_choice == 0:
                        now = datetime.datetime.utcnow()
                    elif time_zone_choice == 1:
                        now = datetime.datetime.now()
                    tstamp = int(now.timestamp())  # Timestamp in the request must be integer.
                    TER12Calcs = []  # Contains calculated values of all TER12 sensors.
                    thingspeak_values = []
                    grafana_json_data = []
                    for an_address in sorted(relay_GPIO.keys()):
                        ser.write(an_address.encode() + b'M!');  # start the SDI-12 sensor measurement
                        # print(an_address.encode()+b'M!'); # start the SDI-12 sensor measurement
                        sdi_12_line = ser.readline()
                        # print(sdi_12_line)
                        sdi_12_line = sdi_12_line[:-2]  # remove \r and \n since [0-9]$ has trouble with \r
                        m = re.search(b'[0-9]$',
                                      sdi_12_line)  # # This should match a number ([0-9]) that appears at the end of the response ($), which is a 1-digit number of "returned values" but it is having trouble with the \r so I removed \r\n in the previous line of code.
                        if (
                        not m):  # Match evaluates into True. The response is wrong. There should be a number at the end of the response,
                            # save r\n, but it is not in the response.
                            no_data = True  # End the current iteration of the sensors and commands on each sensors and wait for the next iteration.
                            break;
                        total_returned_values = int(m.group(0))  # find how many values are returned
                        sdi_12_line = ser.readline()  # read the service request line
                        ser.write(an_address.encode() + b'D0!')  # request data
                        # print(an_address.encode()+b'D0!') # request data
                        sdi_12_line = ser.readline()  # read the data line
                        # print(sdi_12_line)
                        sdi_12_line = sdi_12_line[1:-2]  # remove address, \r and \n since [0-9]$ has trouble with \r

                        TER12Values = []  # Contains raw values from one sensor we're reading. Clear before each sensor
                        for iterator in range(
                                total_returned_values):  # extract the returned values from SDI-12 sensor and append to values[]
                            m = re.search(b'[+-][0-9.]+', sdi_12_line)  # match a number string
                            try:  # if values found is less than values indicated by return from M, report no data found. This is a simple solution to GPS sensors before they acquire lock. For sensors that have lots of values to return, you need to find a better solution.
                                TER12Values.append(float(m.group(0)))  # convert into a number
                                sdi_12_line = sdi_12_line[len(m.group(0)):]
                            except AttributeError:
                                print("No data received from sensor at address %c\n" % (an_address))
                                time.sleep(delay_between_pts)
                                no_data = True
                                break
                        if (no_data == True):
                            break;
                        wc = TER12Values[0]
                        tempC = TER12Values[1]
                        ec = TER12Values[2]
                        VWC_percent_custom = TER12_VWC_percentage_Custom(wc)

                        TER12Calcs.append([tempC, VWC_percent_custom])
                        thingspeak_values.append(VWC_percent_custom)

                        # Automatically irrigate pot
                        if (VWC_percent_custom < min_VWC_percent.get(str(an_address),0)):
                            print("Too Dry, Irrigation Started! VWC values(percentage): Sensor(TEROS12):%s" % (
                                VWC_percent_custom))
                            irrigation_counts = 1
                            GPIO.output(relay_GPIO[an_address], GPIO.LOW)
                            time.sleep(2)
                            GPIO.output(relay_GPIO[an_address], GPIO.HIGH)
                        else:
                            print('Do Not Need Irrigation. VWC values: Sensor(TEROS12): %s' % (VWC_percent_custom))
                            irrigation_counts = 0
                            GPIO.output(relay_GPIO[an_address], GPIO.HIGH)
                    if (no_data == True):
                        no_data = False
                        continue
                    else:
                        # Format output file
                        # Give column header (Edited by Binod 2/21/2024)
                        data_file_name = "%04d%02d%02d.csv" % (now.year, now.month, now.day)
                        #print('Saving to %s' % data_file_name)
                        # Check if the file exists and is empty to write the headers
                        write_headers = not os.path.exists(data_file_name) or os.stat(data_file_name).st_size == 0

                        headers = "Timestamp,Unix_Timestamp"  # Add headers for the first two columns

                        for sensor in sorted(relay_GPIO.keys()):
                            headers += f",Temp_{sensor},VWC_{sensor}"  # Add headers for each sensor

                        headers += '\n'  # Add newline after headers

                        data_file = open(data_file_name, 'a')  # Open yyyymmdd.csv for appending
                        if write_headers:
                            data_file.write(headers)

                        file_output_str = "%04d/%02d/%02d %02d:%02d:%02d%s,%d" % (
                        now.year, now.month, now.day, now.hour, now.minute, now.second, ' GMT' if time_zone_choice == 0 else '',
                        tstamp)  # formatting date and time
                        for oneTER12Calcs in TER12Calcs:
                            file_output_str = file_output_str + ",%s,%s" % (oneTER12Calcs[0], oneTER12Calcs[1])
                        file_output_str = file_output_str + '\n'
                        data_file_name = "%04d%02d%02d.csv" % (now.year, now.month, now.day)
                        print('Saving to %s\n%s' % (data_file_name, file_output_str))
                        data_file = open(data_file_name, 'a')  # open yyyymmdd.csv for appending
                        data_file.write(file_output_str)
                        data_file.close()
                        time.sleep(600)  # the value between the parenthesis is the delay between data even the status says 'Do Not Need Irrigation'.

               #added by Binod to handle serial communication error 12/15/2023
                except serial.SerialException as serial_error:
                    print(f"Serial communication error: {serial_error}")
                    ser.close()
                    try:
                        data_file.close()
                    except:
                        pass
                    sys.exit(1)

#added by Binod to ensure that if an exception occurs during execution of the main loop, the serial port and data file will be closed properly before exiting the program. 12/15/2023
except Exception as e:
    print(f"Error: {e}")
finally:
    try:
        ser.close()
    except:
        pass
    try:
        data_file.close()
    except:
        pass
    print('Quitting program!')
    sys.exit(0)
