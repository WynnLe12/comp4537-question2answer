FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
