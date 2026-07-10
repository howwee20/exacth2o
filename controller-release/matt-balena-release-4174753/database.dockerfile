FROM yobasystems/alpine-mariadb:11.4.9

COPY database/scripts/run.sh /scripts/run.sh
RUN chmod +x /scripts/run.sh

ENTRYPOINT ["/scripts/run.sh"]
CMD ["--verbose"]
