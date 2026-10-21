import { eq, inArray } from 'drizzle-orm';
import { writeFile } from 'node:fs/promises';
import { connectPostgres, closePostgres, getDb } from '../../packages/backend/src/db/index';
import { crawlJobs, crawlPages, searchDocuments, searchUsageEvents, searchUsageRollups } from '../../packages/backend/src/db/schema';
import { processPage } from '../../packages/backend/src/worker';
const ids=['01a1157a-823d-711c-98a0-92aaa0d1b2f0','01a115bf-213d-748a-904f-a9bb58827d0e','01a10e9f-dd51-72bd-9ddc-372e8b28c77b','01a1127f-3267-73b7-b97e-685bee98b3c5','01a1157a-8237-7bdb-bd4a-54222d204902','01a11375-708d-7900-8772-c82188283224'];
const owner='mention-links-real-article-probe'; const jobs:string[]=[];const documents:string[]=[];const results:unknown[]=[];
connectPostgres('postgresql://nate@localhost:5547/clarity_ci');
try {
 for(const id of ids){
  const post=await fetch(`https://api.mention.earth/posts/${id}`).then(r=>r.json());
  const url=post.content.text.match(/https?:\/\/[^\s]+/)[0];const jobId=crypto.randomUUID();jobs.push(jobId);
  await getDb().insert(crawlJobs).values({id:jobId,ownerAccountId:owner,applicationId:owner,kind:'urls',status:'running',idempotencyKey:jobId,callerTier:'internal',pagesDiscovered:1});
  const [page]=await getDb().insert(crawlPages).values({id:crypto.randomUUID(),jobId,url,discoverySource:'api',status:'fetching',attemptCount:1,leaseOwner:owner,leaseExpiresAt:new Date(Date.now()+60000)}).returning();
  const started=Date.now();await processPage(page);
  const [p]=await getDb().select().from(crawlPages).where(eq(crawlPages.id,page.id));
  const doc=await getDb().select().from(searchDocuments).where(eq(searchDocuments.requestedUrl,url));documents.push(...doc.map(d=>d.id));
  const result={id,url,durationMs:Date.now()-started,status:p.status,error:p.lastErrorDetail,documents:doc.map(d=>({status:d.status,title:d.title,description:d.description,image:d.imageUrl,canonical:d.canonicalUrl}))};results.push(result);console.log(JSON.stringify(result));
 }
 await writeFile('.scratch/mention-links/article-results.json',JSON.stringify(results,null,2));
} finally{
 if(jobs.length)await getDb().delete(crawlJobs).where(inArray(crawlJobs.id,jobs));
 if(documents.length)await getDb().delete(searchDocuments).where(inArray(searchDocuments.id,documents));
 await getDb().delete(searchUsageEvents).where(eq(searchUsageEvents.ownerAccountId,owner));
 await getDb().delete(searchUsageRollups).where(eq(searchUsageRollups.ownerAccountId,owner));
 await closePostgres();
}
