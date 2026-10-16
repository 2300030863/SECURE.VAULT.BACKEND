# Production Dockerfile for Secure Vault Backend on Northflank
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0

# Copy dependency manifests and install production packages
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure runtime directories exist
RUN mkdir -p uploads/archives

# Expose port (Northflank maps PORT environment variable dynamically)
EXPOSE 5000

# Start Secure Vault API
CMD ["node", "server.js"]
