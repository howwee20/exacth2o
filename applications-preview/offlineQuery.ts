// Minimal read-only query adapter. Matches paging, filtering and order used by production clients.
// No method can create a network client or mutate a fixture.
export function offlineQuery(source: readonly any[]) {
  let rows=source.slice(), take=Infinity, offset=0;
  const orders: {key:string;ascending:boolean}[]=[];
  const result=()=>{
    const sorted=rows.slice().sort((a,b)=>{for(const order of orders){const x=a[order.key],y=b[order.key];if(x===y)continue;return (x<y?-1:1)*(order.ascending?1:-1);}return 0;});
    return sorted.slice(offset,offset+take);
  };
  const q:any=new Proxy({}, {get(_target,key){
    if(['insert','update','upsert','delete'].includes(String(key)))return ()=>Promise.resolve({data:null,error:{message:'Demo data is read-only.'}});
    if(key==='then')return (resolve:any)=>resolve({data:result(),error:null});
    if(key==='single'||key==='maybeSingle')return ()=>Promise.resolve({data:result()[0]??null,error:null});
    if(key==='order')return (field:string,options:any={})=>{orders.push({key:field,ascending:options.ascending!==false});return q;};
    if(key==='limit')return (n:number)=>{take=n;return q;};
    if(key==='range')return (from:number,to:number)=>{offset=from;take=to-from+1;return q;};
    if(key==='eq'||key==='is')return (field:string,value:unknown)=>{rows=rows.filter(row=>row[field]===value);return q;};
    if(key==='in')return (field:string,values:unknown[])=>{rows=rows.filter(row=>values.includes(row[field]));return q;};
    if(['gte','lte','gt','lt'].includes(String(key)))return (field:string,value:any)=>{rows=rows.filter(row=>key==='gte'?row[field]>=value:key==='lte'?row[field]<=value:key==='gt'?row[field]>value:row[field]<value);return q;};
    if(key==='like')return (field:string,pattern:string)=>{rows=rows.filter(row=>String(row[field]??'').startsWith(pattern.replace(/%$/,'')));return q;};
    if(key==='or')return (expression:string)=>{
      const match=expression.match(/^([a-z_]+)\.lt\.([^,]+),and\(\1\.eq\.([^,]+),id\.lt\.([0-9]+)\)$/);
      if(!match)throw new Error('Unsupported demo query.');
      const [,field,before,,id]=match;rows=rows.filter(row=>row[field]<before||(row[field]===before&&row.id<Number(id)));return q;
    };
    return ()=>q;
  }});
  return q;
}
