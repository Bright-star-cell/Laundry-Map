FROM node:22-alpine AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM dependencies AS build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY frontend frontend
RUN npm run build -w @laundry-map/frontend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /workspace/frontend/.next frontend/.next
COPY --from=build /workspace/frontend/public frontend/public
COPY --from=build /workspace/frontend/package.json frontend/package.json
COPY --from=dependencies /workspace/node_modules node_modules
COPY --from=dependencies /workspace/frontend/node_modules frontend/node_modules
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@laundry-map/frontend"]