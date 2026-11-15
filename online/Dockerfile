FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
