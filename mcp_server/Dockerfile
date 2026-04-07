FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV MCP_PORT=8789
ENV MCP_BIND=0.0.0.0

EXPOSE 8789

CMD ["npm", "run", "start"]
