FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8787
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["npm", "start"]
