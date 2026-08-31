FROM node:20-alpine

WORKDIR /app

# System deps: ca-certs for HTTPS to api.github.com.
RUN apk add --no-cache ca-certificates && update-ca-certificates

COPY package.json ./
RUN npm install --production --no-audit --no-fund

COPY server.js schema.json ./

EXPOSE 3000

# Non-root — least privilege.
RUN addgroup -S app && adduser -S -G app app && chown -R app:app /app
USER app

CMD ["node", "server.js"]
