
import puppeteer from "puppeteer";
import { aiRouter } from "../../lib/aiRouter";
import { checkLimit } from "../../lib/usage";

function prompt(topic,mode){
  return `
  Create ${mode} topper-style notes on "${topic}".
  Use headings, bullets, diagrams.
  Keep concise, structured, exam-ready.
  `;
}

function html(c){
  return `<html><body style="font-family:Arial;padding:40px">
  ${c.replace(/\n/g,"<br>")}
  </body></html>`;
}

export default async function handler(req,res){
  const user = req.headers["x-forwarded-for"] || "guest";
  if(!(await checkLimit(user,"pdf")))
    return res.status(429).json({error:"PDF limit reached"});

  const {topic,mode} = req.body;
  const content = await aiRouter(prompt(topic,mode));

  const browser = await puppeteer.launch({args:["--no-sandbox"]});
  const page = await browser.newPage();
  await page.setContent(html(content));
  const pdf = await page.pdf({format:"A4",printBackground:true});
  await browser.close();

  res.setHeader("Content-Type","application/pdf");
  res.send(pdf);
}
