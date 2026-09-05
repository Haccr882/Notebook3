
import fetch from "node-fetch";

async function callGroq(prompt){
  try{
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{
        "Authorization":`Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        model:"llama3-70b-8192",
        messages:[{role:"user",content:prompt}]
      })
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content || null;
  }catch{return null;}
}

async function callGemini(prompt){
  try{
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({contents:[{parts:[{text:prompt}]}]})
      }
    );
    const d = await r.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  }catch{return null;}
}

async function callOpenRouter(prompt){
  try{
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{
        "Authorization":`Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        model:"openai/gpt-oss-120b",
        messages:[{role:"user",content:prompt}]
      })
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content || null;
  }catch{return null;}
}

function weak(x){ return !x || x.length < 600; }

export async function aiRouter(prompt){
  let res = await callGroq(prompt);
  if(weak(res)) res = await callGemini(prompt);
  if(weak(res)) res = await callOpenRouter(prompt);
  return res || "Failed to generate content";
}
