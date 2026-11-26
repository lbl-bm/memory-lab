export const name='Draft edit, close and reopen';
const current = async page => page.evaluate(()=>{
  const detail={callbacks:0,currentValue:null};
  window.dispatchEvent(new CustomEvent('draft-observation',{detail}));
  return detail;
});
export const setup=async page=>{
  await page.getByRole('button',{name:'Open draft'}).waitFor();
  // Seed the visible saved state before measured or warm-up rounds.
  await page.getByRole('button',{name:'Open draft'}).click();
  await page.getByRole('textbox',{name:'Draft'}).fill('saved draft');
  await page.getByRole('button',{name:'Close draft'}).click();
};
export async function action(page){
  await page.getByRole('button',{name:'Open draft'}).click();
  const input=page.getByRole('textbox',{name:'Draft'});
  if(await input.inputValue()!=='saved draft')throw Error('Reopen lost the draft');
  await input.fill('edited draft');
  if((await current(page)).currentValue!=='edited draft')throw Error('Live draft event is broken');
  await input.fill('saved draft');
  return {reopenedSavedValue:true,currentDraftResponded:true};
}
export async function back(page){
  await page.getByRole('button',{name:'Close draft'}).click();
  if(await page.getByRole('textbox',{name:'Draft'}).count())throw Error('Draft still visible');
  return {closed:true};
}
export async function assertBaseline(page){
  if(await page.locator('#slot section').count()!==0 || await page.locator('#saved').textContent()!=='saved draft'
    || !await page.getByRole('button',{name:'Open draft'}).isEnabled())throw Error('Baseline not restored');
  return {editorCount:0,canOpen:true,savePreserved:true};
}
export async function followup(page){
  await new Promise(resolve=>setTimeout(resolve,200));
  return assertBaseline(page);
}
export async function observe(page){
  const state=await current(page);
  return {draftCallbacks:state.callbacks};
}
