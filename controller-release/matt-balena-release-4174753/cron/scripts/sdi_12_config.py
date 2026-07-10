#!/usr/local/opt/python-3.5.1/bin/python3.5
# SDI-12 Sensor Configuration Tool Copyright Dr. John Liu 2016-02-03
import serial.tools.list_ports
import serial
import time
import datetime
import re

print('+-'*40)
print('SDI-12 Sensor Configuration Tool for Dr. Liu\'s SDI-12 USB adapter\n\t\tDr. John Liu 2016-02-03 V1.0\n\t\tFree software GNU GPL V3.0')
print('\nCompatible with Windows, Linux PC, and Raspberry PI')
print('\nThis program requires Python 3.5 and Pyserial 3.0\n\nFor assistance with customization, telemetry etc., contact Dr. Liu.\n\thttps://liudr.wordpress.com/gadget/sdi-12-usb-adapter/')
print('\nPlease only connect one sensor to the adapter to configure its address.')
print('+-'*40)

port_names=[]
a=serial.tools.list_ports.comports()
for w in a:
    port_names.append(w.device)

port_names.sort()
print('\nDetected the following serial ports:')
i=0
for w in port_names:
    print('%d) %s' %(i,w))
    i=i+1
total_ports=i # now i= total ports

user_port_selection=input('\nSelect port: (0,1,2...)')
if (int(user_port_selection)>=total_ports):
    exit(1) # port selection out of range

ser=serial.Serial(port=port_names[int(user_port_selection)],baudrate=9600,timeout=10)
time.sleep(2.5) # delay for arduino bootloader and the 1 second delay of the adapter.

ser.write(b'?!')
sdi_12_line=ser.readline()

sdi_12_line=sdi_12_line[:-2] # remove \r and \n since [0-9]$ has trouble with \r
m=re.search(b'[0-9a-zA-Z]$',sdi_12_line) # having trouble with the \r
sdi_12_address=m.group(0) # find address

print('Sensor address:', sdi_12_address.decode('utf-8'))
ser.write(sdi_12_address+b'I!')
sdi_12_line=ser.readline()
print('Sensor info:',sdi_12_line.decode('utf-8'))

user_sdi_12_address=input('\nEnter new address (0-9, A-Z, a-z)')
if ((user_sdi_12_address>='0') and (user_sdi_12_address<='9')) or ((user_sdi_12_address>='A') and (user_sdi_12_address<='Z')) or ((user_sdi_12_address>='a') and (user_sdi_12_address<='z')):
    print("Sensor address changed to: ", user_sdi_12_address)
    ser.write(b'%sA%s!' %(sdi_12_address,user_sdi_12_address.encode('utf-8')))
    ser.readline()
    print('\nConfiguration complete.')
else:
    print('Address is invalid. No change was made.')
