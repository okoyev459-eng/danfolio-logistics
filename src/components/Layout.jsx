export default function Layout({ title, children }) {
  return (
    <>
      <div className="topbar">
        <b>Danfolio Logistics · {title}</b>
      </div>
      <div className="page">{children}</div>
    </>
  )
}
