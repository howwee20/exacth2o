FROM balenalib/raspberrypi5-node:20-latest-run
# FROM node:iron
# FROM debian:bullseye-slim

# Set the environment variables from the outside
ARG PORT
ENV PORT $PORT
ENV UDEV=on
EXPOSE $PORT


# start installing deps
# RUN apt-get update
# RUN apt-get -y install build-essential
# RUN apt-get -y install nodejs npm
# Install Python and build tools for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    g++ \
    usbutils \
    i2c-tools \
    uhubctl \
    lsof \
    jq \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# RUN apt install cmake device-tree-compiler libfdt-dev libgnutls28-dev git
# RUN git clone https://github.com/raspberrypi/utils.git
# RUN cd utils/pinctrl && cmake . && make && sudo make install

# Install Python dependencies
COPY requirements.txt ./
COPY scripts/ ./scripts/
# Install other Python packages first (these should work on all architectures)
RUN pip3 install --no-cache-dir  pyserial==3.5 requests==2.31.0
# Try to install RPi.GPIO, but don't fail the build if it's not available
RUN pip3 install --no-cache-dir  RPi.GPIO==0.7.1 || echo "RPi.GPIO not available on this architecture - application will use mock instead"


#RUN install_packages uhubctl
## show usb devices
#RUN uhubctl


# Set the working directory in the Docker image
WORKDIR /app

# Copy only the package.json and package-lock.json files first to leverage Docker cache
COPY package*.json ./
COPY tsconfig.json ./

# Install the application dependencies
RUN npm ci
RUN ls -la
RUN cat tsconfig.json
RUN npx tsc --version


# Copy the rest of the application code to the working directory
COPY . .

# Build the app
RUN npm run build && npm prune --omit=dev

# start up the app
CMD ["npm", "start"]
