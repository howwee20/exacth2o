from pathlib import Path
import subprocess,json,hashlib,os,shutil
repo=Path(__file__).resolve().parent.parent
captures=repo/'design/showcase-20261013'; output=repo/'media'; scratch=Path(os.environ.get('SHOWCASE_SCRATCH','/tmp/exacth2o-showcase')); scratch.mkdir(exist_ok=True)
ff=Path(os.environ.get('FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg')
regular='/System/Library/Fonts/Supplemental/Arial.ttf'; bold='/System/Library/Fonts/Supplemental/Arial Bold.ttf'
scenes=[
 ('01-clean.png',4.8,'RECORDED DROUGHT DATA','See the whole experiment.'),
 ('02-recovery.png',4.4,'DERIVED RECOVERY SCENARIO','Compare the response.'),
 ('04-overlay.png',4.0,'DERIVED RECOVERY SCENARIO','Put irrigation in context.'),
 ('03-saved.png',3.6,'SAVED COMPARISONS','Pick up where you left off.'),
 ('05-export.png',4.8,'RECORDED MEASUREMENTS','Take the full record with you.'),
]
clips=[]
for i,(file,duration,kicker,title) in enumerate(scenes):
 titlefile=scratch/f'title-{i}.txt'; titlefile.write_text(title)
 kickerfile=scratch/f'kicker-{i}.txt';kickerfile.write_text(kicker)
 out=scratch/f'clip-{i}.mp4';frames=round(duration*30)
 filters=f"[0:v]scale=3200:2000,zoompan=z='1+0.008*on/{frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={frames}:s=1600x1000:fps=30,setsar=1[screen];color=c=0x101f1a:s=1920x1200:r=30:d={duration}[bg];[bg][screen]overlay=160:174:shortest=1,drawtext=fontfile='{regular}':textfile='{kickerfile}':fontsize=20:fontcolor=0x83c8b9:x=162:y=33,drawtext=fontfile='{bold}':textfile='{titlefile}':fontsize=50:fontcolor=white:x=160:y=77,drawtext=fontfile='{bold}':text='ExactH2O':fontsize=25:fontcolor=0x83c8b9:x=w-tw-162:y=45,format=yuv420p[v]"
 subprocess.run([str(ff),'-y','-loglevel','error','-i',str(captures/file),'-filter_complex',filters,'-map','[v]','-t',str(duration),'-c:v','libx264','-crf','18','-preset','fast',str(out)],check=True)
 clips.append(out)
# A quiet brand close, with the same colors as the software.
end=scratch/'end.mp4'
filters=f"[1:v]crop=1300:260:80:410,scale=800:160,format=rgba,colorkey=0x000000:0.12:0.05[logo];[0:v][logo]overlay=(W-w)/2:440:shortest=1,drawtext=fontfile='{regular}':text='Precision irrigation for research.':fontsize=36:fontcolor=white:x=(w-tw)/2:y=650,drawtext=fontfile='{regular}':text='exacth2o.com/demo':fontsize=28:fontcolor=0xa6b7ae:x=(w-tw)/2:y=740,format=yuv420p[v]"
subprocess.run([str(ff),'-y','-loglevel','error','-f','lavfi','-i','color=c=0x101f1a:s=1920x1200:r=30:d=3.6','-loop','1','-i',str(repo/'research-portal/src/assets/exacth2o-logo.jpeg'),'-filter_complex',filters,'-map','[v]','-t','3.6','-c:v','libx264','-crf','18','-preset','fast',str(end)],check=True);clips.append(end)
# Short dissolves keep the pace clear and avoid decorative wipe effects.
args=[str(ff),'-y','-loglevel','error'];
for clip in clips:args+=['-i',str(clip)]
f=[];duration=scenes[0][1];prev='0:v'
for i in range(1,len(clips)):
 f.append(f'[{prev}][{i}:v]xfade=transition=fade:duration=0.24:offset={duration-.24:.2f}[v{i}]');prev=f'v{i}';duration+=(scenes[i][1] if i<len(scenes) else 3.6)-.24
f.append(f'[{prev}]format=yuv420p[final]')
mp4=output/'software-tour-20261013.mp4';webm=output/'software-tour-20261013.webm'
subprocess.run(args+['-filter_complex',';'.join(f),'-map','[final]','-c:v','libx264','-crf','18','-preset','fast','-movflags','+faststart',str(mp4)],check=True)
subprocess.run([str(ff),'-y','-loglevel','error','-i',str(mp4),'-c:v','libvpx-vp9','-crf','31','-b:v','0','-row-mt','1','-cpu-used','4',str(webm)],check=True)
subprocess.run([str(ff),'-y','-loglevel','error','-ss','1.5','-i',str(mp4),'-frames:v','1','-q:v','2',str(output/'software-tour-poster-20261013.jpg')],check=True)
subprocess.run([str(ff),'-y','-loglevel','error','-i',str(captures/'02-recovery.png'),'-frames:v','1','-q:v','2',str(repo/'portal-preview-20261013.jpg')],check=True)
(output/'software-tour-20261013-provenance.json').write_text(json.dumps({'created':'2026-10-13','durationSeconds':round(duration,2),'dimensions':[1920,1200],'method':'Edited showcase from real browser captures of the release. Subtle camera movement and short dissolves; no invented product screens.','scenes':[{'capture':s[0],'title':s[3],'context':s[2],'sha256':hashlib.sha256((captures/s[0]).read_bytes()).hexdigest()} for s in scenes],'recordedData':'Binod CSV, unchanged measurement values, dates shifted for demo playback. Recovery and irrigation shots are derived demo scenarios.'},indent=2))
print('Showcase duration',duration,'files',mp4.stat().st_size,webm.stat().st_size)
