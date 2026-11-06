import { PortalLink } from '../product/PortalLink';
import { AutocalibrateWorkspace, type AutocalibrateWorkspaceProps } from './AutocalibrateWorkspace';

export function AutocalibratePage(props: Omit<AutocalibrateWorkspaceProps, 'scope' | 'headingLevel'> & {error?: string | null; notice?: string | null}) {
  const {error, notice, ...workspace} = props;
  return <section className="px-page ac-page" aria-label="Autocalibrate">
    <PortalLink className="px-home-button" to={{view: 'home'}}>← Home</PortalLink>
    {error ? <p className="settings-error-line" role="alert">{error}</p> : null}
    {notice ? <p className="settings-muted" role="status">{notice}</p> : null}
    <AutocalibrateWorkspace {...workspace} scope="installation" headingLevel={1} />
  </section>;
}
