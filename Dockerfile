# Data server image WITH pg_dump (needed by the "Backup" tab of admin.html).
# Save this file as "Dockerfile" next to data_server.js (Railway then builds it automatically instead of Nixpacks/Railpack).
# PG_MAJOR must be the same as, or newer than, your database version (the Backup tab shows both versions).
FROM node:20-bookworm-slim
ARG PG_MAJOR=18
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/keyrings \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-${PG_MAJOR} \
 && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node","data_server.js"]
