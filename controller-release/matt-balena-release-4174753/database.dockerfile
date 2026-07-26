FROM yobasystems/alpine-mariadb:11.4.9

COPY database/scripts/run.sh /scripts/run.sh
COPY database/scripts/healthcheck.sh /scripts/healthcheck.sh
RUN chmod +x /scripts/run.sh /scripts/healthcheck.sh

ENTRYPOINT ["/scripts/run.sh"]
CMD ["--verbose"]
