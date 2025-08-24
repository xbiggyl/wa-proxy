FROM node:20-alpine
WORKDIR /app

# Install dependencies (no lockfile in repo)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app
COPY . .

ENV PORT=3333
EXPOSE 3333
CMD ["npm","start"]
