/**
 * CSS 作为模块导入的类型声明。
 *
 * 只有 KaTeX 的样式表用到（`math.ts` 里跟着 KaTeX 一起懒加载）。
 * 打包器会把它变成一个副作用导入，运行时并不使用返回值。
 */
declare module '*.css' {
  const url: string
  export default url
}
