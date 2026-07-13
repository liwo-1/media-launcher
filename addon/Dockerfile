FROM node:20-alpine

RUN apk add --no-cache jq

WORKDIR /app

COPY app/package.json ./
RUN npm install --omit=dev

COPY app/ ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
