import { cn } from '@/lib/utils'

/** FlowOps brand mark — layered flow nodes representing connected operations. */
export function FlowOpsLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('h-8 w-8', className)}
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="10" fill="currentColor" opacity="0.12" />
      <path
        d="M11 13.5h11.5a4.5 4.5 0 0 1 0 9H17"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <circle cx="11" cy="13.5" r="3.2" fill="currentColor" />
      <circle cx="11" cy="22.5" r="3.2" fill="currentColor" />
      <circle cx="29" cy="22.5" r="3.2" fill="currentColor" opacity="0.55" />
      <path
        d="M14.2 13.5h6.3M14.2 22.5h11.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.3"
      />
    </svg>
  )
}
