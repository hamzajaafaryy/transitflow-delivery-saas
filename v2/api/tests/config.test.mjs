import assert from 'node:assert/strict';
import test from 'node:test';
import { codespacesOrigin, trustedBrowserOrigin } from '../dist/config.js';
import { workingMinutes } from '../dist/sla.js';
import { authorize } from '../dist/security/authorization.js';

test('Codespaces origin rewrite is scoped to this private preview and port',()=>{
  const env={CODESPACES:'true',CODESPACE_NAME:'tf-demo',GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev'};
  const origin=codespacesOrigin(env,3200);
  assert.equal(origin,'https://tf-demo-3200.app.github.dev');
  assert.equal(trustedBrowserOrigin(origin,'http://localhost:3200',origin,'same-origin',env),true);
  assert.equal(trustedBrowserOrigin(origin,'http://localhost:3201',origin,'same-origin',env),false);
  assert.equal(trustedBrowserOrigin(origin,'http://localhost:3200',origin,'cross-site',env),false);
  assert.equal(trustedBrowserOrigin(origin,'http://localhost:3200',undefined,'same-origin',env),false);
  assert.equal(trustedBrowserOrigin(origin,'https://another.app.github.dev',origin,'same-origin',env),false);
});

test('SLA pauses at noon, Sunday and configured Morocco holidays',()=>{
  const start=new Date('2026-11-14T11:30:00Z');
  const end=new Date('2026-11-16T09:30:00Z');
  assert.equal(workingMinutes(start,end,new Set()),300);
  assert.equal(workingMinutes(start,end,new Set(['2026-11-16'])),270);
  assert.equal(workingMinutes(new Date('2026-11-10T11:45:00Z'),new Date('2026-11-10T14:45:00Z'),new Set()),60);
});

test('Developer and employee cannot confirm an agency payment',()=>{
  for(const role of ['DEVELOPER','EMPLOYEE']) assert.equal(authorize({
    id:'test',active:true,role,permissions:['agency_payments.confirm_paid'],
  },'agency_payments.confirm_paid').allowed,false);
});
