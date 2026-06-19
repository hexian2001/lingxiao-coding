import { useTranslation } from 'react-i18next';
import { useViewStore } from '../stores/viewStore';

export default function PlaceholderView() {
  const { t } = useTranslation();
  const mainView = useViewStore((s) => s.mainView);

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-shimmer w-32 h-32 rounded-2xl mx-auto mb-6" />
        <h2 className="text-lg font-medium text-text-primary mb-2 capitalize">
          {mainView}
        </h2>
        <p className="text-sm text-text-secondary">
          {t('app.connecting')}...
        </p>
      </div>
    </div>
  );
}
