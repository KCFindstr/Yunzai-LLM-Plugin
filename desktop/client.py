import json
import socket
import sys

request = json.load(sys.stdin)
with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(45)
    connection.connect('/var/lib/llm-desktop/control/agent.sock')
    connection.sendall(json.dumps(request).encode() + b'\n')
    chunks = bytearray()
    while True:
        chunk = connection.recv(65536)
        if not chunk:
            break
        chunks.extend(chunk)
        if len(chunks) > 12_000_000:
            raise ValueError('desktop response too large')
    sys.stdout.buffer.write(chunks)
