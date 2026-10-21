"use client";
import Link from "next/link";
import { ArrowLeft, BarChart3, Box, ChartNoAxesCombined, CircleHelp, FileText, Grid2X2, Home, Megaphone, Settings, ShoppingBag, Tag, Users } from "lucide-react";
import styles from "./not-found.module.css";

const links = [
  { label: "Dashboard", icon: Home, href: "/dashboard" },
  { label: "Orders", icon: ShoppingBag, href: "/dashboard?view=orders" },
  { label: "Products", icon: Box, href: "/dashboard?view=products" },
  { label: "Customers", icon: Users, href: "/dashboard?view=customers" },
  { label: "Analytics", icon: BarChart3, href: "/dashboard?view=overview" },
  { label: "Marketing", icon: Megaphone, href: "/dashboard?view=ads" },
  { label: "Discounts", icon: Tag, href: "/dashboard?view=discounts" },
  { label: "Apps", icon: Grid2X2, href: "/settings/integrations" },
  { label: "Reports", icon: FileText, href: "/dashboard?view=sales" },
];

function Illustration() {
  return <svg className={styles.illustration} viewBox="0 0 800 475" role="img" aria-label="404: a traveler beside signs pointing to Dashboard and Home">
    <defs>
      <linearGradient id="nf-number" x2="0.2" y2="1"><stop stopColor="#98b5ed"/><stop offset="1" stopColor="#e8efff"/></linearGradient>
      <linearGradient id="nf-hills" x2="0" y2="1"><stop stopColor="#dbe6fc"/><stop offset="1" stopColor="#f8faff"/></linearGradient>
      <linearGradient id="nf-sign"><stop stopColor="#426ac0"/><stop offset="1" stopColor="#86a7e9"/></linearGradient>
    </defs>
    <text x="400" y="245" textAnchor="middle" fill="url(#nf-number)" fontSize="270" fontWeight="800" fontFamily="Arial, sans-serif" letterSpacing="-12">404</text>
    <g fill="#eaf0ff"><path d="M67 264q0-13 13-13 17-34 42-7 18-2 21 20Z"/><path d="M634 291q0-13 21-14 22-39 46-9 22-4 26 23Z"/></g>
    <path d="M8 425q43-52 72-61t55-43q42-44 88 3t91 36q43 5 72 33 40-6 71-36t77 6q23 15 62-3t61-41q36-33 72 10l63 96Z" fill="url(#nf-hills)"/>
    <g fill="#a9c2cb" stroke="#8eacb9" strokeWidth="1.3"><path d="M212 425q-67-75-42-77 18-2 42 77-37-105-13-89 14 14 13 89 8-64 25-64 19 4-25 64Z"/><path d="M305 451q-69-33-48-44 16-7 48 44-38-74-20-73 14-1 20 73 3-60 18-51 12 8-18 51Z"/><path d="M581 438q-27-56-11-52 12 3 11 52 16-79 29-62 5 12-29 62 42-35 36-15-8 12-36 15Z"/></g>
    <g fill="#eaf0fd"><ellipse cx="324" cy="452" rx="48" ry="5"/><ellipse cx="527" cy="464" rx="59" ry="7"/></g>
    <path d="M351 424q-80 24-89 39t101 8q100-8 54-23t-64-22" fill="none" stroke="#c8d9f8" strokeDasharray="13 6"/>
    <path d="M323 451V226q8-10 15 0v225" fill="#465e85"/><path d="M328 226v225" stroke="#738bad" strokeWidth="5"/>
    <path d="m317 239 103 22 17 23-19 15-101-20Z" fill="#284983"/><path d="m323 237 98 22 17 24-18 13-97-20Z" fill="url(#nf-sign)"/>
    <text x="337" y="264" fill="white" fontSize="19" transform="rotate(12 337 264)">Dashboard</text>
    <path d="m307 301-20 22 18 22 83 1v-40Z" fill="#29477f"/><path d="m312 301-19 22 18 20 77 1v-39Z" fill="url(#nf-sign)"/><text x="323" y="330" fill="white" fontSize="19">Home</text>
    <path d="m511 332-9 57 6 62h13l6-59 6-24 4 83h14l6-119Z" fill="#1e2d4d"/>
    <path d="m507 449-10 10q-3 5 23 3l2-13m16 0-2 11q14 6 23 0l-7-11" fill="#fff" stroke="#263655" strokeWidth="1.5"/>
    <path d="m510 273-23 14-20 46 14 27 10-6-8-23 16-22 2 51q26 8 57-1l-3-62 30-15q10-9 1-20l-27-28-8 8 18 25-31 6Z" fill="#365fb2"/>
    <path d="m482 350 8-4 9 12-8 7Zm66-108-7-14 5-8 13 15Zm-36 8-3 22q12 13 22-1l-1-20" fill="#efb5a1"/>
    <path d="M509 239q-6-21 13-21 23-2 20 23l-10 20-16-3Z" fill="#f3c2ad"/>
    <path d="M512 248q-5-9 0-16-17-14-5-20 5-3 11 4 26-1 25 20l-11 19-10-1-1-14q-10-5-9 8Z" fill="#172642"/>
    <path d="M127 450q18-40 47-5l12 5Z" fill="#b8c9df"/>
  </svg>;
}

/** Exported as 404.html, which the Worker serves for any path with no page (not_found_handling). */
export default function NotFound() {
  return (
    <div className={styles.page}>
      <aside className={styles.sidebar}>
        <Link href="/dashboard" className={styles.brand}><ChartNoAxesCombined aria-hidden="true"/><span>BizInsights</span></Link>
        <nav aria-label="Main navigation" className={styles.navigation}>
          {links.map(({ label, icon: Icon, href }) => <Link href={href} key={label}><Icon aria-hidden="true"/><span>{label}</span></Link>)}
        </nav>
        <nav aria-label="Support navigation" className={styles.bottomNavigation}>
          <Link href="/settings/profile"><Settings aria-hidden="true"/><span>Settings</span></Link>
          <Link href="/support"><CircleHelp aria-hidden="true"/><span>Help &amp; Support</span></Link>
        </nav>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.header}>
          <span className={styles.breadcrumb}>Workspace <span>/</span> Page not found</span>
          <div className={styles.headerActions}>
            <Link href="/support" aria-label="Help and support"><CircleHelp/></Link>
            <Link href="/settings/profile" className={styles.profile}><span className={styles.avatar}><Users size={21}/></span><span>Your account<small>Manage profile</small></span></Link>
          </div>
        </header>
        <main className={styles.main}>
          <div className={styles.content}>
            <Illustration/>
            <h1>Page Not Found</h1>
            <p>The page you’re looking for doesn’t exist or may have been moved.<br className={styles.lineBreak}/> Let’s get you back on track.</p>
            <div className={styles.actions}>
              <Link href="/dashboard" className={styles.primary}><Home aria-hidden="true"/>Go to Dashboard</Link>
              <button type="button" onClick={() => { if (window.history.length > 1) window.history.back(); else window.location.assign("/dashboard"); }}><ArrowLeft aria-hidden="true"/>Go Back</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
