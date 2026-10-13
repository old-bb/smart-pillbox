from flask import Flask, Response
import subprocess

app = Flask(__name__)

def generate():
    cmd = [
        "ffmpeg",
        "-f", "v4l2",
        "-i", "/dev/video0",
        "-vf", "scale=640:480",
        "-c:v", "mjpeg",
        "-q:v", "6",
        "-f", "mjpeg",
        "-"
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=10**8)
    buffer = bytearray()
    # jpeg 标记 0xffd8 开始，0xffd9 结束
    while True:
        data = p.stdout.read(4096)
        if not data:
            break
        buffer.extend(data)
        # 找完整jpeg帧
        start = buffer.find(b'\xff\xd8')
        end = buffer.find(b'\xff\xd9', start+2)
        if start != -1 and end != -1:
            jpeg = buffer[start:end+2]
            buffer = buffer[end+2:]
            yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + jpeg + b'\r\n'

@app.route('/')
def index():
    return '''
<html>
<body style="background:#000;margin:0;padding:0;">
<img style="width:100%;" src="/stream">
</body>
</html>
'''

@app.route('/stream')
def stream():
    return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=8080, debug=False)
