FROM ruby:3.4.5-alpine3.22

WORKDIR /app

COPY Gemfile ./
RUN bundle config set without 'development test' && bundle install

COPY Rakefile ./
COPY lib ./lib
COPY db ./db
COPY migration-version.json ./migration-version.json

ENTRYPOINT ["bundle", "exec", "rake"]
