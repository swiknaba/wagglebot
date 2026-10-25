FROM ruby:3.4.5-alpine3.22

WORKDIR /app

RUN apk add --no-cache postgresql17-client \
  && apk add --no-cache --virtual .build-deps build-base postgresql-dev

COPY Gemfile ./
COPY Gemfile.lock ./
RUN bundle config set deployment true \
  && bundle config set frozen true \
  && bundle config set without 'development test' \
  && bundle install \
  && apk del .build-deps

COPY Rakefile ./
COPY lib ./lib
COPY db ./db
COPY migration-version.json ./migration-version.json

ENTRYPOINT ["bundle", "exec", "rake"]
