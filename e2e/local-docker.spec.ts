import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer, request as proxyRequest, type Server } from 'node:http'
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const service=process.env.RIVET_SERVICE_DIR||path.resolve(__dirname,'../../rivet-service')
const web=process.env.RIVET_WEB_DIR||path.resolve(__dirname,'../../rivet-web')
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))

// Собственная БД и git/Docker-фикстура. Основной стенд и CRM не используются.
test('Docker: ранний стенд, управление из консоли, провал обновления и очистка',async({page})=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'rivet-docker-browser-')),preview=path.join(dir,'preview.json')
 let output='',finished=false,exitCode:number|null=null,server:Server|undefined
 const child=spawn('go',['test','-v','./internal/runner','-run','^TestLocalDockerAPIToContainer$','-count=1'],{
  cwd:service,env:{...process.env,RIVET_DOCKER_TEST:'1',RIVET_DOCKER_E2E_PREVIEW_FILE:preview,RIVET_DOCKER_E2E_PREVIEW_DRIVER:'1'},stdio:['ignore','pipe','pipe'],
 })
 const log=(b:Buffer)=>{output=(output+b.toString()).slice(-200_000)};child.stdout.on('data',log);child.stderr.on('data',log)
 const exited=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{finished=true;exitCode=code;resolve()})})
 try{
  await expect.poll(async()=>{if(finished)throw Error(output);try{return !!(await stat(preview))}catch{return false}},{timeout:180_000}).toBe(true)
  const info=JSON.parse(await readFile(preview,'utf8')) as {api_url:string;project_id:string;environment_id:string}
  const target=new URL(info.api_url),dist=path.resolve(web,'dist')
  server=createServer(async(req,res)=>{
   if(req.url?.startsWith('/api/')){
    const upstream=proxyRequest(new URL(req.url,target),{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res)})
    upstream.on('error',()=>{res.writeHead(502);res.end()});res.on('close',()=>upstream.destroy());req.pipe(upstream);return
   }
   try{
    const relative=decodeURIComponent(new URL(req.url??'/','http://fixture').pathname).replace(/^\/+/,''),candidate=path.resolve(dist,relative||'index.html')
    if(candidate!==dist&&!candidate.startsWith(dist+path.sep)){res.writeHead(400);res.end();return}
    let file=candidate;try{if(!(await stat(file)).isFile())file=path.join(dist,'index.html')}catch{file=path.join(dist,'index.html')}
    const mime:Record<string,string>={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'}
    res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');res.end(await readFile(file))
   }catch{res.writeHead(500);res.end('fixture frontend unavailable')}
  })
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const addr=server.address();if(!addr||typeof addr==='string')throw Error('fixture address')
  const base=`http://127.0.0.1:${addr.port}`
  await page.goto(base);await page.getByLabel('Логин',{exact:true}).fill('fixture');await page.getByLabel('Пароль',{exact:true}).fill('fixture-test-password');await page.getByRole('button',{name:'Войти',exact:true}).click()
  await expect(page.getByRole('button',{name:'Новый проект',exact:true})).toBeVisible()
  await page.goto(`${base}/#/p/${info.project_id}/settings/environments`)
  const card=page.locator('.env-card',{hasText:'Локальный стенд'})
  await expect(card.locator('.sess-stage')).toHaveText('работает');await expect(card).toContainText('поколение 1')
  const link=card.getByRole('link');await expect(link).toHaveAttribute('href',/^http:\/\/127\.0\.0\.1:2\d{4}$/)
  const firstURL=await link.getAttribute('href');expect((await page.request.get(firstURL!)).status()).toBe(200)
  await card.getByRole('button',{name:'Настроить',exact:true}).click();const modal=page.locator('.modal')
  await expect(modal.getByLabel('Порт приложения',{exact:true})).toHaveValue('8080')
  await expect(modal.getByText('Команда доставки',{exact:true})).toHaveCount(0)
  await modal.getByLabel('Переменные приложения',{exact:true}).fill('{broken');await expect(modal.getByRole('button',{name:'Сохранить',exact:true})).toBeDisabled()
  await modal.getByRole('button',{name:'Отмена',exact:true}).click()
  await card.getByRole('button',{name:'Перезапустить',exact:true}).click();await expect(card.locator('.sess-stage')).toHaveText('работает');await expect(link).toHaveAttribute('href',firstURL!)
  await card.getByRole('button',{name:'Пересобрать',exact:true}).click();await expect(card).toContainText('поколение 2');await expect(card.locator('.sess-stage')).toHaveText('работает')
  const secondURL=await link.getAttribute('href');expect(secondURL).not.toBe(firstURL);expect((await page.request.get(secondURL!)).status()).toBe(200)
  await writeFile(preview+'.broken','break fixture',{mode:0o600});await expect.poll(async()=>{try{return !!(await stat(preview+'.broken.ready'))}catch{return false}}).toBe(true)
  await card.getByRole('button',{name:'Опубликовать',exact:true}).click();await expect(card.locator('.env-detail')).toContainText('сборка образа не выполнена')
  await expect(card.locator('.sess-stage')).toHaveText('работает');await expect(link).toHaveAttribute('href',secondURL!);expect((await page.request.get(secondURL!)).status()).toBe(200)
  await card.getByRole('button',{name:'Лог сборки',exact:true}).click();await expect(card.locator('pre.term')).toContainText(/syntax|expected|package/)
  await card.getByRole('button',{name:'Остановить',exact:true}).click();await expect(card.locator('.sess-stage')).toHaveText('остановлено')
  await expect(card.getByRole('button',{name:'Перезапустить',exact:true})).toHaveCount(0)
  await card.getByRole('button',{name:'Настроить',exact:true}).click();await page.locator('.modal').getByRole('button',{name:'Удалить',exact:true}).click();await expect(card).toHaveCount(0)
  await page.goto('about:blank');await writeFile(preview+'.done','done',{mode:0o600});await exited
  expect(exitCode,output).toBe(0)
 }finally{
  await page.goto('about:blank').catch(()=>{});await writeFile(preview+'.done','done',{mode:0o600}).catch(()=>{})
  if(!finished){await Promise.race([exited,sleep(15_000)]);if(!finished)child.kill('SIGTERM')}
  if(server)await new Promise<void>(r=>{server!.closeAllConnections();server!.close(()=>r())})
  await rm(dir,{recursive:true,force:true})
 }
})
