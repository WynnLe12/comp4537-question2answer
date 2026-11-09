FROM php:8.3-apache
RUN apt-get update && apt-get install -y --no-install-recommends libonig-dev \
    && docker-php-ext-install mysqli mbstring \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /var/www/html
COPY . .
COPY docker/php/qa-config.php qa-config.php
RUN printf 'ServerName localhost\n' >> /etc/apache2/apache2.conf
EXPOSE 80
