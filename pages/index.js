
import { useState } from "react";

export default function Home(){
  const [topic,setTopic]=useState("");
  const [mode,setMode]=useState("balanced");

  async function generate(){
    const res = await fetch("/api/generate-pdf",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({topic,mode})
    });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "notes.pdf";
    a.click();
  }

  async function chat(){
    const msg = prompt("Ask doubt:");
    const res = await fetch("/api/chat",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({message:msg})
    });
    const d = await res.json();
    alert(d.reply);
  }

  return (
    <div style={{padding:40}}>
      <h1>AI Notes SaaS PRO</h1>
      <input value={topic} onChange={e=>setTopic(e.target.value)} placeholder="Topic"/>
      <select onChange={e=>setMode(e.target.value)}>
        <option value="balanced">Balanced</option>
        <option value="revision">Revision</option>
      </select>
      <button onClick={generate}>Download PDF</button>
      <button onClick={chat}>Ask Doubt</button>
    </div>
  );
}
