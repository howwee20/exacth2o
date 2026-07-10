#!/usr/local/opt/python-3.5.1/bin/python3.5
# SDI-12 Bus Scanner Dr. John Liu 2016-09-25
# Added .strip() to remove \r from input files typed in windows
# Added Ctrl-C handler
# Added sort of serial port placing FTDI at item 0 if it exists

import os # For running command line commands
import time # For delaying in seconds
import datetime # For finding system's real time
import serial.tools.list_ports # For listing available serial ports
import serial # For serial communication
import re # For regular expression support
import platform # For detecting operating system flavor
import urllib.parse # For encoding data to be url safe.
import signal # For trapping ctrl-c or SIGINT
import sys # For exiting program with exit code

SDI_command_delay_ms=380
SDI_command_timeout_ms=1000 # Wait this long for a command to respond although standard is 380.

def SIGINT_handler(signal, frame):
        print('Quitting program!')
        sys.exit(0)
signal.signal(signal.SIGINT, SIGINT_handler)

print('+-'*40)
print('SDI-12 Bus Scanner V1.0')
print('Designed for Dr. Liu\'s SDI-12 USB adapter\n\tDr. John Liu Saint Cloud MN USA 2016-09-25 V1.0\n\t\tFree software GNU GPL V3.0')
print('\nCompatible with Windows, GNU/Linux, Mac OSX, and Raspberry PI')
print('\nThis program assumes that every sensor on the bus already has a unique address.')
print('If you have NOT configured your sensor addresses, they are probably all zero.')
print('\nConfigure them with the config script, one at a time.')
print('\nThis program requires Python 3.4 and Pyserial 3.0')
print ('\nFor assistance with customization, telemetry etc., contact Dr. Liu.\n\thttps://liudr.wordpress.com/gadget/sdi-12-usb-adapter/')
print('+-'*40)

SDI_sensor_addresses=b''
ports=[]
VID_FTDI=0x0403;

a=serial.tools.list_ports.comports()
for w in a:
    ports.append((w.vid,w.device))

ports.sort(key= lambda ports: ports[1])

print('\nDetected the following serial ports:')
i=0
for w in ports:
    if isinstance(w[0],int):
        print('%d) VID=%04X %s' %(i,int(w[0]),w[1]))
    else:
        print('%d) VID=NONE %s' %(i,w[1]))
    i=i+1
total_ports=i # now i= total ports

user_port_selection=input('\nSelect port: (0,1,2...)')
if (int(user_port_selection)>=total_ports):
    exit(1) # port selection out of range

ser=serial.Serial(port=(ports[int(user_port_selection)])[1],baudrate=9600,timeout=SDI_command_timeout_ms/1000)
time.sleep(2.5) # delay for arduino bootloader and the 1 second delay of the adapter.

def detect_SDI_sensors(address_bottom, address_top):
    global SDI_sensor_addresses
    ptr=0
    break_loop_1=False
    temp_add=''
    my_timer=0
    current_address=address_bottom;

    while (1):
        ser.write(current_address)
        ser.write(b'I!')
        if (len(ser.readline())!=0):
            SDI_sensor_addresses=SDI_sensor_addresses+current_address
            print(current_address.decode(),end='')
        else:
            print('.',end='')

        current_address=chr(ord(current_address)+1).encode()
        if (current_address==chr(ord(b'9')+1).encode()):
            current_address=b'A'
        if (current_address==chr(ord(b'Z')+1).encode()):
            current_address=b'a'
        if (current_address>address_top):
            return

print("Scanning SDI-12 address from 1 to z.\nThis takes about 2 minutes. Please be patient...");
total_SDI_sensors=detect_SDI_sensors(b'1', b'z')
if (total_SDI_sensors==0):
    print()
    print("No SDI-12 sensors found. You either don't have an SDI-12 USB adapter or selected the wrong serial port. At the least the SDI-12 USB adapter should show up at address z.")
else:
    print()
    print("Scan complete. Sensors found at the following addresses:")
    print(SDI_sensor_addresses.decode())
    print("Information:")
    time.sleep(1)
    for address in SDI_sensor_addresses:
        ser.write(chr(address).encode())
        ser.write(b'I!')
        print(ser.readline().decode())

print("Thank you!")
ser.close()
