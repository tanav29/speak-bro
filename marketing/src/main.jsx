import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const repo = 'https://github.com/tanav29/speak-bro'

function CopyButton({ value, children = 'copy' }) {
  const [label, setLabel] = useState(children)
  async function copy() {
    try { await navigator.clipboard.writeText(value); setLabel('copied ✓') }
    catch { setLabel('select manually') }
    setTimeout(() => setLabel(children), 1600)
  }
  return <button className={children === 'Copy env' ? 'copy-button' : 'copy-all'} onClick={copy}>{label}</button>
}

function Brand() {
  return <a className="brand" href="#top" aria-label="SpeakBro home"><span className="brand-mark"><i/><i/><i/><i/></span><span>speakbro</span></a>
}

function App() {
  return <>
    <div className="grain" />
    <header className="nav wrap"><Brand/><nav><a href="#how">How it works</a><a href="#stack">The stack</a><a href="#setup">Setup</a></nav><a className="nav-cta" href="#setup">Run locally <span>↗</span></a></header>
    <main id="top">
      <section className="hero wrap"><div className="hero-copy"><p className="kicker"><span className="live-dot"/> A local-first voice co-pilot</p><h1>Talk to your<br/><em>working memory.</em></h1><p className="hero-lede">SpeakBro listens, thinks, remembers what matters, and speaks back. A voice interface for the projects and details you want to keep moving.</p><div className="hero-actions"><a className="button button-fill" href="#setup">Build your own <span>→</span></a><a className="text-link" href={repo} target="_blank" rel="noreferrer">View the repo <span>↗</span></a></div><div className="hero-notes"><span>⌘&nbsp; Hold Space to talk</span><span>◉&nbsp; Runs on your machine</span></div></div>
        <div className="hero-media"><div className="video-frame"><div className="video-top"><span className="live-dot"/><span>SEE SPEAKBRO IN MOTION</span><span className="video-time">02:14</span></div><div className="video-embed"><iframe src="https://www.youtube-nocookie.com/embed/fktKtaFS8es?rel=0&modestbranding=1" title="SpeakBro demo" loading="eager" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen/></div><div className="video-caption"><span>Voice in. Context out.</span><span className="mono">LOCAL / MEMORY / OPEN</span></div></div><div className="media-note"><span className="wave-mini"><i/><i/><i/><i/><i/></span> press play to meet your co-pilot</div></div>
      </section>
      <section className="signal-strip"><div className="wrap strip-inner"><span>THE SIGNAL</span><p>Fast enough to feel conversational. Private enough to feel like yours.</p><span className="mono">STT → LLM → TTS</span></div></section>
      <section id="how" className="section wrap"><div className="section-heading"><p className="eyebrow">A conversation with continuity</p><h2>Not just an answer.<br/><span>A useful next move.</span></h2></div><div className="steps">{[['◌','Speak naturally','Hold Space and say what you need. The browser streams 16 kHz microphone audio over a WebSocket.'],['✦','Let it reason','Local Whisper transcribes your words. A configurable OpenAI-compatible model handles the thinking.'],['⌁','Keep what matters','Durable facts land in SuperMemory. Piper speaks the response back, ready for the next turn.']].map(([icon,title,text],i)=><article className="step" key={title}><span className="step-number">0{i+1}</span><div className="step-icon">{icon}</div><h3>{title}</h3><p>{text}</p></article>)}</div></section>
      <section id="stack" className="stack-section"><div className="wrap stack-grid"><div className="stack-intro"><p className="eyebrow">Under the hood</p><h2>Small pieces.<br/><span>Clear boundaries.</span></h2><p>SpeakBro keeps the voice loop close to home, while leaving the model layer open to your preferred provider.</p></div><div className="diagram"><div className="diagram-node node-input"><strong>MICROPHONE</strong><small>16 kHz mono PCM</small></div><div className="diagram-line"/><div className="diagram-node node-backend"><strong>FASTAPI</strong><small>WebSocket voice loop</small></div><div className="diagram-branches">{[['WHISPER','local speech-to-text'],['YOUR LLM','Groq · Ollama · compatible'],['PIPER','local text-to-speech']].map(([a,b],i)=><div className={`diagram-node ${i===1?'accent-node':''}`} key={a}><strong>{a}</strong><small>{b}</small></div>)}</div><div className="memory-node">↗ <b>SUPERMEMORY</b><small>persistent context</small></div></div></div></section>
      <section id="setup" className="section setup-section wrap"><div className="section-heading setup-heading"><div><p className="eyebrow">Get it running</p><h2>Your first conversation<br/><span>is three commands away.</span></h2></div><p>Bring a microphone, Python 3.11+, Node, and your SuperMemory + LLM keys. Optional services can wait.</p></div><div className="setup-layout"><div className="terminal"><div className="terminal-top"><span className="term-dot red"/><span className="term-dot yellow"/><span className="term-dot green"/><span className="terminal-title">speakbro / setup</span><CopyButton value={'cd backend\nuv sync\nuv run uvicorn main:app --reload --port 8000'}/></div><pre><code><span className="muted"># terminal 01 — backend</span>{'\n'}<span className="prompt">$</span> cd backend &amp;&amp; uv sync{ '\n'}<span className="prompt">$</span> uv run uvicorn main:app --reload --port 8000{ '\n\n'}<span className="muted"># terminal 02 — frontend</span>{'\n'}<span className="prompt">$</span> cd frontend &amp;&amp; npm install{ '\n'}<span className="prompt">$</span> npm run dev</code></pre></div><div className="env-card"><div className="env-card-top"><span className="eyebrow">01 / configure</span><span className="file-badge">.env</span></div><p>Add your keys to the repository root. Ollama works too — just point the endpoint at localhost.</p><div className="env-code"><code>SUPER_MEM_KEY=<span>your-key</span><br/>LLM_API_KEY=<span>your-key</span><br/>LLM_BASE_URL=<span>https://api.groq.com/openai/v1</span><br/>LLM_MODEL_NAME=<span>openai/gpt-oss-20b</span></code><CopyButton value={'SUPER_MEM_KEY=your-key\nLLM_API_KEY=your-key\nLLM_BASE_URL=https://api.groq.com/openai/v1\nLLM_MODEL_NAME=openai/gpt-oss-20b'}>Copy env</CopyButton></div><a className="docs-link" href={`${repo}#readme`} target="_blank" rel="noreferrer">Read full README <span>↗</span></a></div></div><div className="setup-foot"><span>Then open <b>localhost:5173</b></span><span className="status"><i/> your voice loop is live</span></div></section>
      <section className="closing wrap"><p className="kicker"><span className="live-dot"/> Open source, local-first, yours</p><h2>Make the interface<br/><em>feel like you.</em></h2><a className="button button-fill" href="#setup">Start with SpeakBro <span>→</span></a></section>
    </main>
    <footer className="footer wrap"><Brand/><span>Voice for the work in progress.</span><span className="mono">© 2024 / LOCAL-FIRST</span></footer>
  </>
}
export default App

createRoot(document.getElementById('root')).render(<App />)
