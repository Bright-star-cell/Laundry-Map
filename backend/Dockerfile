FROM node:22-alpine AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM dependencies AS build
COPY backend backend
RUN npm run build -w @laundry-map/backend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /workspace/backend/dist backend/dist
COPY --from=build /workspace/backend/db backend/db
COPY --from=build /workspace/backend/migrations backend/migrations
COPY --from=build /workspace/backend/package.json backend/package.json
COPY --from=dependencies /workspace/node_modules node_modules
COPY --from=dependencies /workspace/backend/node_modules backend/node_modules
EXPOSE 4000
CMD ["sh", "-c", "npm run migrate -w @laundry-map/backend && npm run start -w @laundry-map/backend"]