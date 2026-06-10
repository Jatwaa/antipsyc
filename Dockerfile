FROM node:22-alpine
WORKDIR /app
COPY . .
EXPOSE 8717
ENV ANTIPSYC_PORT=8717
# v2: NODE_ENV set to production; --mcp removed (stdio not useful in a container).
ENV NODE_ENV=production
CMD ["node", "./src/server.js", "--http"]
