# Build stage — compile TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
COPY src/ ./src/
RUN npm ci --ignore-scripts && npm run build

# Runtime stage — Playwright base image with Chromium pre-installed
FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app

# Install virtual display, window manager, and VNC/noVNC stack
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled application from builder
COPY --from=builder /app/build ./build

# Create checkpoint directory
RUN mkdir -p /checkpoints

# Copy startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

ENV DISPLAY=:99
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

EXPOSE 6080 6081
CMD ["/start.sh"]
