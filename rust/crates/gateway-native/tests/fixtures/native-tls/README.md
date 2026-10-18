# Synthetic native HTTPS fixture

These DER files are a synthetic CA, localhost/127.0.0.1 server certificate and its P-256 PKCS#8 private key. They are public test material with no production authority. The HTTPS unit fixture supplies this CA only through a private test constructor; normal publication transport uses WebPKI and rejects it. The certificate also permits a real TLS handshake without any live certificate, provider credential or network service.
