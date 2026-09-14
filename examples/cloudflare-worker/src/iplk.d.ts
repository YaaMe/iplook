// wrangler's Data rule gives the import an ArrayBuffer.
declare module "*.iplk" {
  const data: ArrayBuffer;
  export default data;
}
