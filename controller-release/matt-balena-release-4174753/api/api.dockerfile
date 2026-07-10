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
    build-essential \
    g++ \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# RUN install_packages uhubctl
# show usb devices
# RUN uhubctl


# Set the working directory in the Docker image
WORKDIR /app

# Copy only the package.json and package-lock.json files first to leverage Docker cache
COPY package*.json ./
COPY tsconfig.json ./

# Install the application dependencies
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Build the app
RUN npm run build

# start up the app
CMD ["npm", "start"]
