/**
 * SectionHeader
 * Consistent visual header for each anchor section in the Agent Detail page.
 * Renders an id anchor, icon, step number, title, and description.
 */
interface SectionHeaderProps {
    id: string
    step: number
    icon: React.ReactNode
    title: string
    description: string
    action?: React.ReactNode
}

export default function SectionHeader({
    id,
    step,
    icon,
    title,
    description,
    action,
}: SectionHeaderProps) {
    return (
        <div id={id} className="scroll-mt-6">
            <div className="flex items-start justify-between mb-5">
                <div className="flex items-center gap-4">
                    {/* Step badge + icon */}
                    <div className="relative flex-shrink-0">
                        <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-md">
                            {icon}
                        </div>
                        <div className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-white dark:bg-gray-900 border-2 border-indigo-100 dark:border-gray-700 flex items-center justify-center">
                            <span className="text-[9px] font-bold text-indigo-600 dark:text-indigo-400">{step}</span>
                        </div>
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{title}</h2>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
                    </div>
                </div>
                {action && <div className="flex-shrink-0">{action}</div>}
            </div>
        </div>
    )
}
