# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (incl. dev) for the TypeScript build.
# Uses `npm install` so it works even before package-lock.json is refreshed for
# the newly added deps (express, jose). Run `npm install` locally and commit the
# updated lockfile if you prefer reproducible `npm ci` builds.
COPY package.json package-lock.json* ./
RUN npm install

# Compile src -> build/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Compiled output (package.json is already present above; version.ts reads it)
COPY --from=build /app/build ./build

# Run as the non-root user that the node image ships with
USER node

EXPOSE 3000
CMD ["node", "build/http.js"]
