
import { aiRouter } from "../../lib/aiRouter";
import { checkLimit } from "../../lib/usage";

export default async function handler(req,res){
  const user = req.headers["x-forwarded-for"] || "guest";
  if(!(await checkLimit(user,"chat")))
    return res.status(429).json({error:"Chat limit reached"});

  const {message} = req.body;
  const reply = await aiRouter(message);
  res.json({reply});
}
