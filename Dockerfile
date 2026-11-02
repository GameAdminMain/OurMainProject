# Dockerfile for the DATA SERVER (data_server.js): profile / winners / verify / admin dashboard API.
# It also installs the PostgreSQL client tools, because the admin "Database backup" button runs pg_dump.
#
# Railway: in the data server service, save this file as "Dockerfile" next to data_server.js
# (or set the service variable RAILWAY_DOCKERFILE_PATH=Dockerfile.data_server), then redeploy.
#
# PG_MAJOR must be your database's major version or newer (pg_dump refuses older servers' newer versions).
# The database is PostgreSQL 18 today; change it here, or pass --build-arg PG_MAJOR=19 if the database is upgraded.
FROM node:22-bookworm-slim

ARG PG_MAJOR=18

# PostgreSQL client (pg_dump, psql) from the official PostgreSQL apt repository, so any recent major version is available
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-${PG_MAJOR} \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first (cached between deploys). npm install, not npm ci: package-lock.json is not in sync with package.json.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Only the files the data server needs (keeps the committed node_modules folder out of the image)
COPY data_server.js db.js tg_auth.js reconcile.js ./

ENV PORT=3001
EXPOSE 3001
USER node
CMD ["node", "data_server.js"]
