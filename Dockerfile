FROM node:20-alpine

WORKDIR /app

# Install only production deps. All pure-JS now (no native modules), so no
# system build-deps are required.
COPY package*.json ./
RUN npm ci --omit=dev

# Application code.
COPY src ./src

ENV NODE_ENV=production
ENV PORT=2567
EXPOSE 2567

CMD ["node", "src/index.js"]
